#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { spawn, spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, resolve } from "path";

const TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;
const START_TIMEOUT = 20000;
const CHECK_SETTLE_MS = parseInteger(
  process.env.OBSCURA_CHECK_SETTLE_MS || "1500",
  1500,
);
const HEURISTIC_VERSION = "2026-04-30.2";
const DEFAULT_VERSION = process.env.OBSCURA_VERSION || "v0.1.1";
const DEFAULT_PORT = parseInt(process.env.OBSCURA_PORT || "9223", 10);
const IS_WINDOWS = process.platform === "win32";
if (!IS_WINDOWS) process.umask(0o077);

const RUNTIME_DIR = IS_WINDOWS
  ? resolve(
      process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local"),
      "obscura-cdp",
    )
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, "obscura-cdp")
    : resolve(homedir(), ".cache", "obscura-cdp");
const STATE_FILE = resolve(RUNTIME_DIR, "server.json");
const LOG_FILE = resolve(RUNTIME_DIR, "obscura.log");
const BINARY_DIR = resolve(RUNTIME_DIR, "bin");
const BUNDLED_BIN = resolve(BINARY_DIR, IS_WINDOWS ? "obscura.exe" : "obscura");

mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
mkdirSync(BINARY_DIR, { recursive: true, mode: 0o700 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function truncate(text, max = 72) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseInteger(value, fallback) {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function removeState() {
  try {
    unlinkSync(STATE_FILE);
  } catch {}
}

function getConfig() {
  return {
    port: DEFAULT_PORT,
    stealth: envFlag("OBSCURA_STEALTH", false),
    workers: parseInteger(process.env.OBSCURA_WORKERS || "1", 1),
    proxy: process.env.OBSCURA_PROXY || "",
  };
}

function findOnPath(command) {
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(IS_WINDOWS ? ";" : ":")) {
    if (!dir) continue;
    const candidate = resolve(dir, command);
    if (existsSync(candidate)) return candidate;
    if (IS_WINDOWS) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        const windowsCandidate = candidate + ext;
        if (existsSync(windowsCandidate)) return windowsCandidate;
      }
    }
  }
  return null;
}

function getAssetForPlatform(version) {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      archiveName: "obscura-aarch64-macos.tar.gz",
      binaryName: "obscura",
      url: `https://github.com/h4ckf0r0day/obscura/releases/download/${version}/obscura-aarch64-macos.tar.gz`,
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      archiveName: "obscura-x86_64-macos.tar.gz",
      binaryName: "obscura",
      url: `https://github.com/h4ckf0r0day/obscura/releases/download/${version}/obscura-x86_64-macos.tar.gz`,
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      archiveName: "obscura-x86_64-linux.tar.gz",
      binaryName: "obscura",
      url: `https://github.com/h4ckf0r0day/obscura/releases/download/${version}/obscura-x86_64-linux.tar.gz`,
    };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      archiveName: "obscura-x86_64-windows.zip",
      binaryName: "obscura.exe",
      url: `https://github.com/h4ckf0r0day/obscura/releases/download/${version}/obscura-x86_64-windows.zip`,
    };
  }
  throw new Error(
    `No published Obscura binary is known for ${process.platform}/${process.arch}. ` +
      "Set OBSCURA_BIN to a local build or installed binary.",
  );
}

function findFileRecursive(rootDir, fileName) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = resolve(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    }
    if (!entry.isFile() && !entry.isDirectory()) {
      try {
        const stats = statSync(fullPath);
        if (stats.isFile() && entry.name === fileName) return fullPath;
      } catch {}
    }
  }
  return null;
}

async function installBundledObscura() {
  const asset = getAssetForPlatform(DEFAULT_VERSION);
  if (existsSync(BUNDLED_BIN)) return BUNDLED_BIN;

  const tempDir = resolve(
    RUNTIME_DIR,
    `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const archivePath = resolve(tempDir, asset.archiveName);

  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      throw new Error(
        `download failed (${response.status} ${response.statusText})`,
      );
    }
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

    if (asset.archiveName.endsWith(".tar.gz")) {
      const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", tempDir], {
        encoding: "utf8",
      });
      if (extracted.status !== 0) {
        throw new Error(
          extracted.stderr?.trim() ||
            extracted.stdout?.trim() ||
            "tar extraction failed",
        );
      }
    } else if (asset.archiveName.endsWith(".zip")) {
      const extracted = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`,
        ],
        { encoding: "utf8" },
      );
      if (extracted.status !== 0) {
        throw new Error(
          extracted.stderr?.trim() ||
            extracted.stdout?.trim() ||
            "zip extraction failed",
        );
      }
    }

    const extractedBinary = findFileRecursive(tempDir, asset.binaryName);
    if (!extractedBinary) {
      throw new Error(`could not locate ${asset.binaryName} after extraction`);
    }

    const tempBin = `${BUNDLED_BIN}.tmp`;
    writeFileSync(tempBin, readFileSync(extractedBinary));
    if (!IS_WINDOWS) chmodSync(tempBin, 0o755);
    renameSync(tempBin, BUNDLED_BIN);
    if (!IS_WINDOWS) chmodSync(BUNDLED_BIN, 0o755);
    return BUNDLED_BIN;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function locateExistingObscuraBin() {
  if (process.env.OBSCURA_BIN) return process.env.OBSCURA_BIN;
  const pathBinary = findOnPath("obscura");
  if (pathBinary) return pathBinary;
  if (existsSync(BUNDLED_BIN)) return BUNDLED_BIN;
  return null;
}

async function resolveObscuraBin() {
  const existing = locateExistingObscuraBin();
  if (existing) return existing;
  if (envFlag("OBSCURA_AUTO_INSTALL", true)) return installBundledObscura();
  throw new Error("Obscura not found. Install it or set OBSCURA_BIN.");
}

async function inspectServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return { running: false };
    const data = await response.json();
    return {
      running: true,
      isObscura: /^Obscura\//.test(String(data.Browser || "")),
      data,
    };
  } catch {
    return { running: false };
  }
}

async function waitForServer(port, timeoutMs = START_TIMEOUT) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await inspectServer(port);
    if (state.running && state.isObscura) return state.data;
    await sleep(250);
  }
  throw new Error(
    `Obscura did not start within ${timeoutMs}ms. See ${LOG_FILE}`,
  );
}

async function ensureServer() {
  const config = getConfig();
  const current = await inspectServer(config.port);
  if (current.running && current.isObscura)
    return { info: current.data, started: false, config };
  if (current.running && !current.isObscura) {
    throw new Error(
      `Port ${config.port} is already in use by another debugger (${current.data?.Browser || "unknown"}). ` +
        "Set OBSCURA_PORT to another port.",
    );
  }

  const obscuraBin = await resolveObscuraBin();
  const args = [
    "serve",
    "--allow-private-network",
    "--port",
    String(config.port),
  ];
  if (config.proxy) args.push("--proxy", config.proxy);
  if (config.stealth) args.push("--stealth");
  if (config.workers > 1) args.push("--workers", String(config.workers));

  const logFd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn(obscuraBin, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  writeState({
    pid: child.pid,
    bin: obscuraBin,
    config,
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE,
  });

  const info = await waitForServer(config.port);
  return { info, started: true, config };
}

async function stopServer() {
  const state = readState();
  const port = state?.config?.port || DEFAULT_PORT;
  const before = await inspectServer(port);
  if (!before.running) {
    removeState();
    return "No managed Obscura server is running.";
  }
  if (!state?.pid) {
    throw new Error(
      `An Obscura server is running on port ${port}, but it was not started by this skill. ` +
        "Stop it manually or remove it from that port.",
    );
  }

  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/PID", String(state.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const current = await inspectServer(port);
    if (!current.running) {
      removeState();
      return `Stopped Obscura on port ${port}.`;
    }
    await sleep(100);
  }

  throw new Error(`Failed to stop Obscura on port ${port}.`);
}

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Map();

  async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (event) =>
        reject(new Error(`WebSocket error: ${event.message || event.type}`));
      this.#ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.#pending.has(message.id)) {
          const { resolve, reject } = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error)
            reject(
              new Error(message.error.message || JSON.stringify(message.error)),
            );
          else resolve(message.result);
          return;
        }
        if (message.method && this.#eventHandlers.has(message.method)) {
          for (const handler of this.#eventHandlers.get(message.method)) {
            handler(message.params || {}, message);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method))
      this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  close() {
    this.#ws?.close();
  }
}

async function connectBrowser() {
  const { info, started, config } = await ensureServer();
  const wsUrl =
    info.webSocketDebuggerUrl ||
    `ws://127.0.0.1:${config.port}/devtools/browser`;
  const cdp = new CDP();
  await cdp.connect(wsUrl);
  return { cdp, info, started, config };
}

async function getTargets(cdp) {
  const { targetInfos = [] } = await cdp.send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "page");
}

function resolvePrefix(prefix, candidates, noun = "target") {
  const normalized = String(prefix).toLowerCase();
  const matches = candidates.filter((candidate) =>
    candidate.toLowerCase().startsWith(normalized),
  );
  if (matches.length === 0) {
    throw new Error(`No ${noun} matching prefix "${prefix}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s.`,
    );
  }
  return matches[0];
}

function formatTargetList(targets) {
  if (targets.length === 0)
    return "No pages open. Use: obscura-cdp.mjs open https://example.com";
  const idWidth = Math.max(
    ...targets.map((target) => target.targetId.length),
    6,
  );
  return targets
    .map((target) => {
      const id = target.targetId.padEnd(idWidth);
      const title = truncate(target.title || "(untitled)", 44).padEnd(44);
      return `${id}  ${title}  ${target.url}`;
    })
    .join("\n");
}

async function resolveTarget(cdp, prefix) {
  const targets = await getTargets(cdp);
  const targetId = resolvePrefix(
    prefix,
    targets.map((target) => target.targetId),
  );
  return targets.find((target) => target.targetId === targetId);
}

async function attachToTarget(cdp, targetId) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return sessionId;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError || new Error(`Failed to attach to target ${targetId}`);
}

async function evalStr(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        "Evaluation failed",
    );
  }
  const value = result.result?.value;
  if (value === undefined) {
    return typeof result.result?.description === "string"
      ? result.result.description
      : "";
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function waitForDocumentReady(
  cdp,
  sessionId,
  timeoutMs = NAVIGATION_TIMEOUT,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sessionId, "document.readyState");
      if (state === "complete") return;
    } catch {}
    await sleep(200);
  }
  throw new Error("Timed out waiting for page load to finish.");
}

async function markdownStr(cdp, sessionId) {
  try {
    const result = await cdp.send("LP.getMarkdown", {}, sessionId);
    return result.markdown || "";
  } catch {
    return evalStr(cdp, sessionId, 'document.body?.innerText || ""');
  }
}

async function htmlStr(cdp, sessionId, selector) {
  const expression = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : 'document.documentElement?.outerHTML || ""';
  return evalStr(cdp, sessionId, expression);
}

async function netStr(cdp, sessionId) {
  const json = await evalStr(
    cdp,
    sessionId,
    `JSON.stringify(performance.getEntriesByType('resource').map(entry => ({
    name: entry.name,
    type: entry.initiatorType,
    duration: Math.round(entry.duration),
    size: entry.transferSize || 0,
  })))`,
  );
  const rows = JSON.parse(json || "[]");
  return rows
    .map(
      (entry) =>
        `${String(entry.duration).padStart(5)}ms  ${String(entry.size).padStart(8)}B  ${String(entry.type || "?").padEnd(10)}  ${truncate(entry.name, 120)}`,
    )
    .join("\n");
}

async function navStr(cdp, sessionId, url) {
  const allowed =
    url === "about:blank" ||
    url.startsWith("data:") ||
    /^https?:\/\//.test(url);
  if (!allowed)
    throw new Error(
      `Only http/https, data:, or about:blank URLs are supported, got: ${url}`,
    );
  await cdp.send("Page.enable", {}, sessionId);
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", NAVIGATION_TIMEOUT);
  const result = await cdp.send("Page.navigate", { url }, sessionId);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  try {
    if (result.loaderId) await loadEvent.promise;
    else loadEvent.cancel();
  } catch {
    // Obscura's lifecycle events are still evolving; readyState polling below is the real guard.
  } finally {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sessionId, 5000);
  return `Navigated to ${url}`;
}

function collectIssues(snapshot) {
  const issues = [];
  const doc = snapshot.documentMetrics;
  const docWidth = Math.max(
    doc.bodyScrollWidth,
    doc.docScrollWidth,
    doc.bodyClientWidth,
    doc.docClientWidth,
  );
  const docHeight = Math.max(
    doc.bodyScrollHeight,
    doc.docScrollHeight,
    doc.bodyClientHeight,
    doc.docClientHeight,
  );
  const buttonRects = snapshot.sampleButtonRects || [];
  const tinyRects = buttonRects.filter(
    (rect) => rect.width <= 120 && rect.height <= 32,
  );
  const uniqueButtonRects = new Set(
    buttonRects.map(
      (rect) => `${rect.left},${rect.top},${rect.width},${rect.height}`,
    ),
  ).size;

  if (!String(snapshot.title || "").trim()) {
    issues.push({
      severity: "warn",
      code: "empty-title",
      message: "Page title is empty.",
    });
  }
  if (snapshot.readyState !== "complete") {
    issues.push({
      severity: "warn",
      code: "not-ready",
      message: `Document readyState is ${snapshot.readyState}.`,
    });
  }
  if (snapshot.linkStylesheetCount > 0 && snapshot.stylesheetCount === 0) {
    issues.push({
      severity: "error",
      code: "stylesheets-not-applied",
      message: `Found ${snapshot.linkStylesheetCount} stylesheet link(s) but document.styleSheets is 0.`,
    });
  }
  const interactiveCount =
    (snapshot.buttonCount || 0) +
    (snapshot.inputCount || 0) +
    (snapshot.textareaCount || 0) +
    (snapshot.selectCount || 0);

  if (
    snapshot.bodyTextLength >= 100 &&
    docHeight <= 60 &&
    (snapshot.linkStylesheetCount > 0 || interactiveCount > 0)
  ) {
    issues.push({
      severity: "error",
      code: "layout-collapsed-height",
      message: `Document height looks collapsed (${docHeight}px) despite substantial text content.`,
    });
  }
  if (
    snapshot.bodyTextLength >= 100 &&
    docWidth <= 160 &&
    (snapshot.linkStylesheetCount > 0 || interactiveCount > 0)
  ) {
    issues.push({
      severity: "error",
      code: "layout-collapsed-width",
      message: `Document width looks collapsed (${docWidth}px) despite substantial text content.`,
    });
  }
  if (
    buttonRects.length >= 3 &&
    uniqueButtonRects <= 1 &&
    tinyRects.length >= Math.min(3, buttonRects.length)
  ) {
    issues.push({
      severity: "error",
      code: "duplicate-tiny-button-rects",
      message:
        "Multiple interactive controls share the same tiny rectangle, suggesting layout/rendering failure.",
    });
  }
  if (
    (snapshot.verificationScriptSrcs?.length || 0) > 0 ||
    (snapshot.captchaTermsFound?.length || 0) > 0
  ) {
    issues.push({
      severity: "warn",
      code: "verification-detected",
      message:
        "Verification / anti-bot indicators were detected; Chrome fallback is safer for this site.",
    });
  }
  return issues;
}

function assessCompatibility(snapshot, extraIssues = []) {
  const issues = [...collectIssues(snapshot), ...extraIssues];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warn");
  let score = 100;
  for (const issue of issues) score -= issue.severity === "error" ? 25 : 10;
  score = Math.max(0, score);

  let status = "compatible";
  if (errors.length > 0) status = "incompatible";
  else if (warnings.length > 0 || score < 85) status = "risky";

  const riskLevel =
    status === "compatible" ? "low" : status === "risky" ? "medium" : "high";
  const recommendedEngine = status === "compatible" ? "obscura" : "chrome";
  return {
    heuristicVersion: HEURISTIC_VERSION,
    status,
    riskLevel,
    score,
    recommendedEngine,
    issueCounts: {
      total: issues.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    decision: {
      shouldFallbackToChrome: recommendedEngine === "chrome",
      primaryReason: issues[0]?.message || null,
    },
    issues,
    reasons: issues.map((issue) => issue.message),
    snapshot,
  };
}

async function evalJson(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `JSON.stringify(${expression})`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        "Evaluation failed",
    );
  }
  const raw = result.result?.value ?? result.result?.description ?? "null";
  return JSON.parse(raw || "null");
}

async function compatibilitySnapshot(cdp, sessionId) {
  await cdp.send("Page.enable", {}, sessionId).catch(() => {});
  await waitForDocumentReady(cdp, sessionId, 5000).catch(() => {});
  if (CHECK_SETTLE_MS > 0) await sleep(CHECK_SETTLE_MS);

  const basic = await evalJson(
    cdp,
    sessionId,
    `(() => {
    const buttonSelectors = 'button, input[type="button"], input[type="submit"], input[type="radio"], input[type="checkbox"], [role="button"]';
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      bodyTextLength: (document.body?.innerText || '').trim().length,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      documentMetrics: {
        bodyScrollWidth: document.body?.scrollWidth || 0,
        bodyScrollHeight: document.body?.scrollHeight || 0,
        bodyClientWidth: document.body?.clientWidth || 0,
        bodyClientHeight: document.body?.clientHeight || 0,
        docScrollWidth: document.documentElement?.scrollWidth || 0,
        docScrollHeight: document.documentElement?.scrollHeight || 0,
        docClientWidth: document.documentElement?.clientWidth || 0,
        docClientHeight: document.documentElement?.clientHeight || 0,
      },
      linkStylesheetCount: document.querySelectorAll('link[rel="stylesheet"]').length,
      stylesheetCount: document.styleSheets.length,
      externalScriptCount: document.querySelectorAll('script[src]').length,
      inputCount: document.querySelectorAll('input').length,
      textareaCount: document.querySelectorAll('textarea').length,
      selectCount: document.querySelectorAll('select').length,
      buttonCount: document.querySelectorAll(buttonSelectors).length,
    };
  })()`,
  );

  const verification = await evalJson(
    cdp,
    sessionId,
    `(() => {
    const verifyTestRegex = /(captcha|slider|slide|verify|verification|recaptcha|hcaptcha|turnstile|geetest|aliyun|tencent|arkose|static-verify|滑块|验证)/i;
    const verifyMatchRegex = /(captcha|slider|slide|verify|verification|recaptcha|hcaptcha|turnstile|geetest|aliyun|tencent|arkose|static-verify|滑块|验证)/ig;
    const bodyText = (document.body?.innerText || '').trim();
    const scriptSrcs = Array.from(document.querySelectorAll('script[src]')).map((script) => script.src).filter(Boolean);
    const linkHrefs = Array.from(document.querySelectorAll('link[href]')).map((link) => link.href).filter(Boolean);
    const probeText = [document.title, bodyText, ...scriptSrcs, ...linkHrefs].join('\n').slice(0, 200000);
    return {
      verificationScriptSrcs: scriptSrcs.filter((src) => verifyTestRegex.test(src)).slice(0, 20),
      captchaTermsFound: Array.from(new Set((probeText.match(verifyMatchRegex) || []).map((term) => term.toLowerCase()))).slice(0, 20),
    };
  })()`,
  );

  const sampleButtonRects = await evalJson(
    cdp,
    sessionId,
    `(() => {
    const buttonSelectors = 'button, input[type="button"], input[type="submit"], input[type="radio"], input[type="checkbox"], [role="button"]';
    const toRect = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        text: (element.textContent || element.value || '').trim().slice(0, 48),
        className: String(element.className || '').slice(0, 120),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return Array.from(document.querySelectorAll(buttonSelectors)).slice(0, 12).map(toRect);
  })()`,
  );

  const sampleControlRects = await evalJson(
    cdp,
    sessionId,
    `(() => {
    const toRect = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        text: (element.textContent || element.value || '').trim().slice(0, 48),
        className: String(element.className || '').slice(0, 120),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"]')).slice(0, 20).map(toRect);
  })()`,
  );

  const noscriptTexts = await evalJson(
    cdp,
    sessionId,
    `(() => Array.from(document.querySelectorAll('noscript')).map((node) => (node.textContent || '').trim()).filter(Boolean).slice(0, 5))()`,
  );

  return {
    ...basic,
    verificationScriptSrcs: verification?.verificationScriptSrcs || [],
    captchaTermsFound: verification?.captchaTermsFound || [],
    sampleButtonRects: sampleButtonRects || [],
    sampleControlRects: sampleControlRects || [],
    noscriptTexts: noscriptTexts || [],
  };
}

function formatCompatibilityReport(report) {
  const {
    snapshot,
    status,
    score,
    recommendedEngine,
    issues,
    riskLevel,
    heuristicVersion,
  } = report;
  const doc = snapshot.documentMetrics;
  const lines = [
    `Compatibility check: ${snapshot.href}`,
    `status: ${status}`,
    `recommended engine: ${recommendedEngine}`,
    `score: ${score}/100`,
    `risk level: ${riskLevel}`,
    `heuristics: ${heuristicVersion}`,
    `title: ${snapshot.title || "(empty)"}`,
    `readyState: ${snapshot.readyState}`,
    `stylesheets: ${snapshot.stylesheetCount} applied / ${snapshot.linkStylesheetCount} linked`,
    `scripts: ${snapshot.externalScriptCount} external`,
    `controls: ${snapshot.inputCount} input, ${snapshot.textareaCount} textarea, ${snapshot.selectCount} select, ${snapshot.buttonCount} button-like`,
    `document size: ${Math.max(doc.bodyScrollWidth, doc.docScrollWidth)} x ${Math.max(doc.bodyScrollHeight, doc.docScrollHeight)}`,
  ];

  if (snapshot.verificationScriptSrcs.length > 0) {
    lines.push(
      `verification scripts: ${snapshot.verificationScriptSrcs.join(", ")}`,
    );
  }
  if (snapshot.captchaTermsFound.length > 0) {
    lines.push(`verification hints: ${snapshot.captchaTermsFound.join(", ")}`);
  }

  if (issues.length === 0) {
    lines.push("issues: none");
  } else {
    lines.push("issues:");
    for (const issue of issues)
      lines.push(`- [${issue.severity}] ${issue.message}`);
  }

  if (snapshot.sampleButtonRects.length > 0) {
    lines.push("sample button rects:");
    for (const rect of snapshot.sampleButtonRects.slice(0, 6)) {
      lines.push(
        `- ${rect.tag} ${JSON.stringify(rect.text)} @ (${rect.left},${rect.top}) ${rect.width}x${rect.height}`,
      );
    }
  }

  return lines.join("\n");
}

async function checkUrlCompatibility(url) {
  const allowed =
    url === "about:blank" ||
    url.startsWith("data:") ||
    /^https?:\/\//.test(url);
  if (!allowed)
    throw new Error(
      `Only http/https, data:, or about:blank URLs are supported, got: ${url}`,
    );

  const { cdp } = await connectBrowser();
  let targetId;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url }));
    const sessionId = await attachToTarget(cdp, targetId);
    const snapshot = await compatibilitySnapshot(cdp, sessionId);
    return assessCompatibility(snapshot);
  } finally {
    if (targetId) {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    cdp.close();
  }
}

async function clickStr(cdp, sessionId, selector) {
  const raw = await evalStr(
    cdp,
    sessionId,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    element.scrollIntoView({ block: 'center' });
    element.focus?.();

    const type = (element.getAttribute('type') || '').toLowerCase();
    if (type === 'radio') element.checked = true;
    if (type === 'checkbox') element.checked = !element.checked;

    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof element.click === 'function') element.click();
    if ((type === 'radio' || type === 'checkbox') && !element.checked) element.checked = true;
    if (type === 'radio' || type === 'checkbox') {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return {
      ok: true,
      tag: element.tagName,
      type,
      checked: 'checked' in element ? !!element.checked : null,
      text: (element.textContent || element.value || '').trim().slice(0, 80),
    };
  })()`,
  );
  const result = JSON.parse(raw);
  if (!result.ok) throw new Error(result.error);
  const suffix = result.checked == null ? "" : ` checked=${result.checked}`;
  return `Clicked <${result.tag}> ${JSON.stringify(result.text)}${suffix}`;
}

async function fillStr(cdp, sessionId, selector, text) {
  const raw = await evalStr(
    cdp,
    sessionId,
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    element.focus();
    element.scrollIntoView({ block: 'center' });
    if (!('value' in element)) return { ok: false, error: 'Element is not fillable: ' + element.tagName };

    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (setter) setter.call(element, ${JSON.stringify(text)});
    else element.value = ${JSON.stringify(text)};

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      tag: element.tagName,
      length: String(element.value).length,
    };
  })()`,
  );
  const result = JSON.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return `Filled <${result.tag}> with ${result.length} characters`;
}

async function typeStr(cdp, sessionId, text) {
  if (!text) throw new Error("Text required.");
  for (const char of Array.from(text)) {
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "char", text: char },
      sessionId,
    );
  }
  return `Typed ${Array.from(text).length} characters`;
}

async function loadAllStr(cdp, sessionId, selector, intervalMs = 1500) {
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(
      cdp,
      sessionId,
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (exists !== "true") break;
    const clicked = await evalStr(
      cdp,
      sessionId,
      `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.scrollIntoView({ block: 'center' });
      element.click();
      return true;
    })()`,
    );
    if (clicked !== "true") break;
    clicks += 1;
    await sleep(intervalMs);
  }
  return `Clicked ${JSON.stringify(selector)} ${clicks} time(s)`;
}

async function evalRawStr(cdp, sessionId, method, paramsJson) {
  if (!method) throw new Error("CDP method required.");
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      throw new Error(`Invalid JSON params: ${paramsJson}`);
    }
  }
  const result = await cdp.send(method, params, sessionId);
  return JSON.stringify(result, null, 2);
}

async function withTarget(prefix, handler) {
  const { cdp } = await connectBrowser();
  try {
    const target = await resolveTarget(cdp, prefix);
    const sessionId = await attachToTarget(cdp, target.targetId);
    return await handler({ cdp, target, sessionId });
  } finally {
    cdp.close();
  }
}

const USAGE = `obscura-cdp - lightweight Pi helper around the Obscura headless browser

Usage: obscura-cdp <command> [args]

Server lifecycle
  start                          Start a local Obscura daemon if needed
  status                         Show daemon and binary status
  stop                           Stop the managed Obscura daemon

Page management
  list                           List page targets
  open   [url]                   Open a new page (default: https://example.com)
  close  <target>                Close a page target
  nav    <target> <url>          Navigate target to a URL

Inspection
  check [--json] <url>          Probe site compatibility for Obscura and recommend obscura vs chrome
  md     <target>                Markdown snapshot via Obscura LP.getMarkdown
  snap   <target>                Alias for md
  html   <target> [selector]     Full HTML or one element's outerHTML
  eval   <target> <expr>         Evaluate JavaScript in the page
  net    <target>                Performance resource entries
  evalraw <target> <method> [json]   Raw CDP call

Interaction
  click  <target> <selector>     Click an element by CSS selector
  fill   <target> <selector> <text>  Set value and dispatch input/change events
  type   <target> <text>         Type into the focused element via key events
  loadall <target> <selector> [ms]   Click a selector until it disappears

Environment
  OBSCURA_BIN=/path/to/obscura   Use a specific Obscura binary
  OBSCURA_PORT=9223              Port for the local daemon (default: 9223)
  OBSCURA_STEALTH=1              Start with --stealth
  OBSCURA_WORKERS=4              Start with --workers 4
  OBSCURA_PROXY=http://...       Start with --proxy
  OBSCURA_AUTO_INSTALL=0         Disable automatic binary download
  OBSCURA_VERSION=v0.1.1         Override the auto-download release version
  OBSCURA_CHECK_SETTLE_MS=1500   Extra settle time before compatibility checks
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(USAGE);
    return;
  }

  if (command === "start") {
    const { info, started, config } = await ensureServer();
    console.log(
      started
        ? `Started Obscura on port ${config.port} (${info.Browser})`
        : `Obscura already running on port ${config.port} (${info.Browser})`,
    );
    return;
  }

  if (command === "status") {
    const config = getConfig();
    const state = readState();
    const server = await inspectServer(config.port);
    const bin =
      locateExistingObscuraBin() ||
      "unavailable (will auto-install on first start)";
    const lines = [
      `binary: ${bin}`,
      `runtime: ${RUNTIME_DIR}`,
      `log: ${LOG_FILE}`,
      `port: ${config.port}`,
      `stealth: ${config.stealth ? "on" : "off"}`,
      `workers: ${config.workers}`,
      `proxy: ${config.proxy || "(none)"}`,
      `server: ${server.running && server.isObscura ? server.data.Browser : "stopped"}`,
    ];
    if (state?.pid) lines.push(`pid: ${state.pid}`);
    console.log(lines.join("\n"));
    return;
  }

  if (command === "stop") {
    console.log(await stopServer());
    return;
  }

  if (command === "list" || command === "ls") {
    const { cdp } = await connectBrowser();
    try {
      console.log(formatTargetList(await getTargets(cdp)));
    } finally {
      cdp.close();
    }
    return;
  }

  if (command === "check" || command === "compat") {
    const jsonMode = args[0] === "--json";
    const url = jsonMode ? args[1] : args[0];
    if (!url) throw new Error("Usage: check [--json] <url>");
    const report = await checkUrlCompatibility(url);
    console.log(
      jsonMode
        ? JSON.stringify(report, null, 2)
        : formatCompatibilityReport(report),
    );
    return;
  }

  if (command === "open") {
    const url = args[0] || "https://example.com";
    const { cdp } = await connectBrowser();
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url });
      console.log(`Opened ${targetId}  ${url}`);
    } finally {
      cdp.close();
    }
    return;
  }

  if (command === "close") {
    if (!args[0]) throw new Error("Target required for close.");
    const { cdp } = await connectBrowser();
    try {
      const target = await resolveTarget(cdp, args[0]);
      await cdp.send("Target.closeTarget", { targetId: target.targetId });
      console.log(`Closed ${target.targetId}`);
    } finally {
      cdp.close();
    }
    return;
  }

  if (command === "eval") {
    if (!args[0]) throw new Error("Target required for eval.");
    const expression = args.slice(1).join(" ");
    if (!expression) throw new Error("Expression required for eval.");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        evalStr(cdp, sessionId, expression),
      ),
    );
    return;
  }

  if (command === "html") {
    if (!args[0]) throw new Error("Target required for html.");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        htmlStr(cdp, sessionId, args[1]),
      ),
    );
    return;
  }

  if (command === "md" || command === "snap") {
    if (!args[0]) throw new Error(`Target required for ${command}.`);
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        markdownStr(cdp, sessionId),
      ),
    );
    return;
  }

  if (command === "nav") {
    if (!args[0] || !args[1]) throw new Error("Usage: nav <target> <url>");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        navStr(cdp, sessionId, args[1]),
      ),
    );
    return;
  }

  if (command === "click") {
    if (!args[0] || !args[1])
      throw new Error("Usage: click <target> <selector>");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        clickStr(cdp, sessionId, args[1]),
      ),
    );
    return;
  }

  if (command === "fill") {
    if (!args[0] || !args[1] || args.length < 3)
      throw new Error("Usage: fill <target> <selector> <text>");
    const text = args.slice(2).join(" ");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        fillStr(cdp, sessionId, args[1], text),
      ),
    );
    return;
  }

  if (command === "type") {
    if (!args[0] || args.length < 2)
      throw new Error("Usage: type <target> <text>");
    const text = args.slice(1).join(" ");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        typeStr(cdp, sessionId, text),
      ),
    );
    return;
  }

  if (command === "loadall") {
    if (!args[0] || !args[1])
      throw new Error("Usage: loadall <target> <selector> [ms]");
    const intervalMs = args[2] ? parseInt(args[2], 10) : 1500;
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        loadAllStr(cdp, sessionId, args[1], intervalMs),
      ),
    );
    return;
  }

  if (command === "net") {
    if (!args[0]) throw new Error("Usage: net <target>");
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) => netStr(cdp, sessionId)),
    );
    return;
  }

  if (command === "evalraw") {
    if (!args[0] || !args[1])
      throw new Error("Usage: evalraw <target> <method> [json]");
    const paramsJson = args.length > 2 ? args.slice(2).join(" ") : "";
    console.log(
      await withTarget(args[0], ({ cdp, sessionId }) =>
        evalRawStr(cdp, sessionId, args[1], paramsJson),
      ),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
