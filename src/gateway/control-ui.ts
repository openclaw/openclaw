import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  isPackageProvenControlUiRootSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isWithinDir } from "../infra/path-safety.js";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { classifyControlUiRequest } from "./control-ui-routing.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
const MAX_HISTORY_FILES = 200;
const MAX_HISTORY_BYTES = 50 * 1024 * 1024;

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  agentId?: string;
  root?: ControlUiRootState;
};

export type ControlUiRootState =
  | { kind: "bundled"; path: string }
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Extensions recognised as static assets.  Missing files with these extensions
 * return 404 instead of the SPA index.html fallback.  `.html` is intentionally
 * excluded — actual HTML files on disk are served earlier, and missing `.html`
 * paths should fall through to the SPA router (client-side routers may use
 * `.html`-suffixed routes).
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
]);

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function loadSessionHistoryFiles(agentId?: string): { name: string; b64: string }[] {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const files: { name: string; b64: string }[] = [];
  if (!fs.existsSync(sessionsDir)) {
    return files;
  }

  const jsonlFiles = fs
    .readdirSync(sessionsDir)
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".lock"))
    .map((file) => ({ name: file, mtime: fs.statSync(path.join(sessionsDir, file)).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_HISTORY_FILES);

  let totalBytes = 0;
  for (const { name } of jsonlFiles) {
    const filePath = path.join(sessionsDir, name);
    const bytes = fs.readFileSync(filePath);
    if (totalBytes + bytes.length > MAX_HISTORY_BYTES) {
      break;
    }
    totalBytes += bytes.length;
    files.push({ name, b64: bytes.toString("base64") });
  }

  return files;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function respondControlUiAssetsUnavailable(
  res: ServerResponse,
  options?: { configuredRootPath?: string },
) {
  if (options?.configuredRootPath) {
    respondPlainText(
      res,
      503,
      `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return;
  }
  respondPlainText(res, 503, CONTROL_UI_ASSETS_MISSING_MESSAGE);
}

function respondHeadForFile(req: IncomingMessage, res: ServerResponse, filePath: string): boolean {
  if (req.method !== "HEAD") {
    return false;
  }
  res.statusCode = 200;
  setStaticFileHeaders(res, filePath);
  res.end();
  return true;
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (!isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondControlUiNotFound(res);
    return true;
  }

  const safeAvatar = resolveSafeAvatarFile(resolved.filePath);
  if (!safeAvatar) {
    respondControlUiNotFound(res);
    return true;
  }
  try {
    if (respondHeadForFile(req, res, safeAvatar.path)) {
      return true;
    }

    serveResolvedFile(res, safeAvatar.path, fs.readFileSync(safeAvatar.fd));
    return true;
  } finally {
    fs.closeSync(safeAvatar.fd);
  }
}

const SESSION_VIEWER_JS = `
function b64toStr(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function sessionLabel(name) {
  if (name.includes(".reset.")) return "[reset] ";
  if (name.includes(".deleted.")) return "[deleted] ";
  return "";
}
function parseSession(name, b64) {
  const text = b64toStr(b64);
  const lines = text.split("\\n").filter((line) => line.trim());
  const messages = [];
  let firstTs = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!firstTs && entry.timestamp) firstTs = entry.timestamp;
      if (entry.type !== "message") continue;
      const msg = entry.message || {};
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      let content = "";
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((part) => part.type === "text")
          .map((part) => part.text || "")
          .join("\\n");
      }
      content = content.replace(/Conversation info[\\s\\S]*?\`\`\`\\s*\\n?/g, "");
      content = content.replace(/\\[\\[reply_to_current\\]\\]\\s*/g, "");
      const match = content.match(/\\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\\]]+\\]\\s+([\\s\\S]+)/);
      if (match) content = match[1].trim();
      content = content.trim();
      if (!content) continue;
      messages.push({ role, content, timestamp: entry.timestamp, model: entry.model || (msg.model || "") });
    } catch (error) {
      // Ignore malformed lines.
    }
  }
  const date = firstTs
    ? new Date(firstTs).toLocaleString("en-US", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : name.substring(0, 19);
  const label = sessionLabel(name);
  return { name, date, label, messages };
}
let cur = -1;
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmt(s) {
  let html = esc(s);
  html = html.replace(/\`\`\`[\\w]*\\n([\\s\\S]*?)\`\`\`/g, function (_, code) {
    return "<pre><code>" + code.trimEnd() + "</code></pre>";
  });
  html = html.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
  html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  return html;
}
function fmtTime(t) {
  try {
    return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  } catch (error) {
    return "";
  }
}
function renderList() {
  const list = document.getElementById("list");
  list.innerHTML = SESSIONS.map(function (s, i) {
    const badge = s.label ? '<span style="font-size:10px;color:#cf222e;font-weight:600">' + s.label + "</span>" : "";
    return '<div class="s-item' + (i === cur ? " active" : "") + '" data-idx="' + i + '">' + '<div class="s-date">' + badge + s.date + '</div>' + '<div class="s-meta">' + s.messages.length + " messages</div></div>";
  }).join("");
  list.querySelectorAll(".s-item").forEach(function (el) {
    el.addEventListener("click", function () {
      selectSession(parseInt(el.getAttribute("data-idx"), 10));
    });
  });
}
function selectSession(i) {
  cur = i;
  renderList();
  const s = SESSIONS[i];
  document.getElementById("top").innerHTML = '<strong>' + s.date + "</strong>" + (s.label ? ' <span style="color:#cf222e;font-size:11px">' + s.label.trim() + "</span>" : "") + ' &nbsp;&middot;&nbsp; ' + esc(s.name.substring(0, 36)) + "...";
  const box = document.getElementById("msgs");
  box.className = "msgs";
  if (!s.messages.length) {
    box.innerHTML = '<div style="margin:auto;text-align:center;color:#8c959f;padding:40px">No messages</div>';
    document.getElementById("footer").style.display = "none";
    return;
  }
  box.innerHTML = s.messages.map(function (m) {
    const t = fmtTime(m.timestamp);
    const mod = m.model ? m.model.split("/").pop() : "";
    const who = m.role === "user" ? "You" : "Agent";
    const meta = who + (mod ? " · " + mod : "") + (t ? " · " + t : "");
    const av = m.role === "user" ? "&#128100;" : "&#129422;";
    return '<div class="msg ' + m.role + '"><div class="av ' + m.role + '">' + av + '</div><div class="bub"><div class="meta">' + meta + '</div><div class="txt">' + fmt(m.content) + '</div></div></div>';
  }).join("");
  const rev = s.messages.slice().reverse();
  const lm = rev.find(function (m) {
    return m.role === "assistant" && m.model;
  });
  document.getElementById("fC").textContent = s.messages.length;
  document.getElementById("fM").textContent = lm ? lm.model.split("/").pop() : "—";
  document.getElementById("footer").style.display = "flex";
  box.scrollTop = box.scrollHeight;
}
`;

function buildSessionViewerHtml(basePath: string): string {
  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f8fa;color:#24292f;display:flex;height:100vh;overflow:hidden}.sidebar{width:260px;min-width:260px;background:#fff;border-right:1px solid #d0d7de;display:flex;flex-direction:column}.sidebar h2{padding:12px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#57606a;border-bottom:1px solid #d0d7de;background:#f6f8fa}.s-list{overflow-y:auto;flex:1}.s-item{padding:11px 16px;border-bottom:1px solid #eaeef2;cursor:pointer;transition:background .1s}.s-item:hover{background:#f6f8fa}.s-item.active{background:#dbeafe;border-left:3px solid #2563eb}.s-date{font-size:13px;font-weight:600;color:#24292f;margin-bottom:2px}.s-meta{font-size:11px;color:#57606a}.chat{flex:1;display:flex;flex-direction:column;overflow:hidden}.chat-top{padding:10px 20px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a}.chat-top strong{color:#24292f}.msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}.msg{display:flex;gap:10px}.msg.user{flex-direction:row-reverse}.av{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;align-self:flex-start;margin-top:16px;background:#e8f4fd}.av.user{background:#fde8f4}.bub{max-width:calc(100% - 48px)}.meta{font-size:11px;color:#8c959f;margin-bottom:4px}.msg.user .meta{text-align:right}.txt{background:#f6f8fa;border:1px solid #d0d7de;border-radius:10px;padding:10px 14px;font-size:13.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:#24292f}.msg.user .txt{background:#eff6ff;border-color:#bfdbfe;color:#1e3a5f}.txt code{background:#e8edf2;padding:1px 5px;border-radius:3px;font-family:Consolas,monospace;font-size:12px;color:#0550ae}.txt pre{background:#f0f3f6;border:1px solid #d0d7de;border-radius:6px;padding:10px;margin:6px 0;overflow-x:auto}.txt pre code{background:none;padding:0;color:#24292f}.txt strong{font-weight:600}.footer{padding:8px 20px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:12px;color:#57606a;display:flex;gap:20px}.footer span{color:#24292f;font-weight:600}.empty{flex:1;display:flex;align-items:center;justify-content:center;color:#8c959f;font-size:14px}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#d0d7de;border-radius:3px}`;

  const historyJsUrl = basePath ? `${basePath}/history.js` : "/history.js";
  const html = [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8">',
    "<title>OpenClaw History</title>",
    `<style>${css}</style>`,
    "</head><body>",
    '<div class="sidebar"><h2>&#129422; OpenClaw History</h2><div class="s-list" id="list"></div></div>',
    '<div class="chat">',
    '<div class="chat-top" id="top">&#8592; Select a session</div>',
    '<div class="msgs empty" id="msgs">Loading...</div>',
    '<div class="footer" id="footer" style="display:none">Messages: <span id="fC"></span> &nbsp; Model: <span id="fM"></span></div>',
    "</div>",
    `<script src="${historyJsUrl}"></script>`,
    "</body></html>",
  ].join("");
  return html;
}

function handleSessionHistoryRoute(
  res: ServerResponse,
  pathname: string,
  basePath: string,
  agentId?: string,
): boolean {
  const historyPath = basePath ? `${basePath}/history` : "/history";
  const historyJsPath = basePath ? `${basePath}/history.js` : "/history.js";

  if (pathname === historyJsPath) {
    const rawJson = JSON.stringify(loadSessionHistoryFiles(agentId));
    const js = [
      SESSION_VIEWER_JS,
      `var RAW=${rawJson};`,
      "var SESSIONS=RAW.map(function(f){return parseSession(f.name,f.b64);});",
      "renderList();if(SESSIONS.length>0)selectSession(0);",
    ].join("\n");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.end(js, "utf8");
    return true;
  }

  if (pathname !== historyPath && pathname !== `${historyPath}/`) {
    return false;
  }

  const html = buildSessionViewerHtml(basePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.end(html, "utf8");
  return true;
}

function setStaticFileHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
}

function serveResolvedFile(res: ServerResponse, filePath: string, body: Buffer) {
  setStaticFileHeaders(res, filePath);
  res.end(body);
}

function serveResolvedIndexHtml(res: ServerResponse, body: string) {
  const hashes = computeInlineScriptHashes(body);
  if (hashes.length > 0) {
    res.setHeader(
      "Content-Security-Policy",
      buildControlUiCspHeader({ inlineScriptHashes: hashes }),
    );
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function resolveSafeAvatarFile(filePath: string): { path: string; fd: number } | null {
  const opened = openVerifiedFileSync({
    filePath,
    rejectPathSymlink: true,
    maxBytes: AVATAR_MAX_BYTES,
  });
  if (!opened.ok) {
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
  rejectHardlinks: boolean,
): { path: string; fd: number } | null {
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    rejectHardlinks,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      io: (failure) => {
        throw failure.error;
      },
      fallback: () => null,
    });
  }
  return { path: opened.path, fd: opened.fd };
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
  });
  if (route.kind === "not-control-ui") {
    return false;
  }
  if (route.kind === "not-found") {
    applyControlUiSecurityHeaders(res);
    respondControlUiNotFound(res);
    return true;
  }
  if (route.kind === "redirect") {
    applyControlUiSecurityHeaders(res);
    res.statusCode = 302;
    res.setHeader("Location", route.location);
    res.end();
    return true;
  }

  applyControlUiSecurityHeaders(res);

  // Session history viewer — served dynamically from .jsonl files
  if (handleSessionHistoryRoute(res, pathname, basePath, opts?.agentId)) {
    return true;
  }

  const bootstrapConfigPath = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  if (pathname === bootstrapConfigPath) {
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarValue = resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: identity.agentId,
      basePath,
    });
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue ?? identity.avatar,
      assistantAgentId: identity.agentId,
      serverVersion: resolveRuntimeServiceVersion(process.env),
    } satisfies ControlUiBootstrapConfig);
    return true;
  }

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    respondControlUiAssetsUnavailable(res, { configuredRootPath: rootState.path });
    return true;
  }
  if (rootState?.kind === "missing") {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const root =
    rootState?.kind === "resolved" || rootState?.kind === "bundled"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if (isExpectedSafePathError(error)) {
        return null;
      }
      throw error;
    }
  })();
  if (!rootReal) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }

  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot =
    rootState?.kind === "bundled" ||
    (rootState === undefined &&
      isPackageProvenControlUiRootSync(root, {
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      }));
  const rejectHardlinks = !isBundledRoot;
  const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (safeFile) {
    try {
      if (respondHeadForFile(req, res, safeFile.path)) {
        return true;
      }
      if (path.basename(safeFile.path) === "index.html") {
        serveResolvedIndexHtml(res, fs.readFileSync(safeFile.fd, "utf8"));
        return true;
      }
      serveResolvedFile(res, safeFile.path, fs.readFileSync(safeFile.fd));
      return true;
    } finally {
      fs.closeSync(safeFile.fd);
    }
  }

  // If the requested path looks like a static asset (known extension), return
  // 404 rather than falling through to the SPA index.html fallback.  We check
  // against the same set of extensions that contentTypeForExt() recognises so
  // that dotted SPA routes (e.g. /user/jane.doe, /v2.0) still get the
  // client-side router fallback.
  if (STATIC_ASSET_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  const safeIndex = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
  if (safeIndex) {
    try {
      if (respondHeadForFile(req, res, safeIndex.path)) {
        return true;
      }
      serveResolvedIndexHtml(res, fs.readFileSync(safeIndex.fd, "utf8"));
      return true;
    } finally {
      fs.closeSync(safeIndex.fd);
    }
  }

  respondControlUiNotFound(res);
  return true;
}
