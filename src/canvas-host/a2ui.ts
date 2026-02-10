import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMime } from "../media/mime.js";

export const A2UI_PATH = "/__openclaw__/a2ui";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export const CANVAS_WS_PATH = "/__openclaw__/ws";

let cachedA2uiRootReal: string | undefined;
let resolvingA2uiRoot: Promise<string | null> | null = null;

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  const pushCandidate = (value: string | undefined) => {
    if (!value) {
      return;
    }
    const resolved = path.resolve(value);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  const explicitRoot = process.env.OPENCLAW_A2UI_ROOT?.trim();
  if (explicitRoot) {
    pushCandidate(explicitRoot);
  }

  if (process.execPath) {
    pushCandidate(path.resolve(path.dirname(process.execPath), "a2ui"));
  }
  if (process.argv[1]) {
    const argvDir = path.dirname(path.resolve(process.argv[1]));
    // Works when running bundled dist/entry.js from npm installs.
    pushCandidate(path.resolve(argvDir, "canvas-host/a2ui"));
    pushCandidate(path.resolve(argvDir, "a2ui"));
  }
  // Running from source (bun) or dist (tsc + copied assets).
  pushCandidate(path.resolve(here, "a2ui"));
  // Running from a bundled dist chunk rooted at dist/*.js.
  pushCandidate(path.resolve(here, "canvas-host/a2ui"));
  // Running from dist without copied assets (fallback to source).
  pushCandidate(path.resolve(here, "../../src/canvas-host/a2ui"));
  // Running from repo root.
  pushCandidate(path.resolve(process.cwd(), "src/canvas-host/a2ui"));
  pushCandidate(path.resolve(process.cwd(), "dist/canvas-host/a2ui"));

  for (const dir of candidates) {
    try {
      const indexPath = path.join(dir, "index.html");
      const bundlePath = path.join(dir, "a2ui.bundle.js");
      await fs.stat(indexPath);
      await fs.stat(bundlePath);
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveA2uiRootReal(): Promise<string | null> {
  if (cachedA2uiRootReal) {
    return cachedA2uiRootReal;
  }
  if (!resolvingA2uiRoot) {
    resolvingA2uiRoot = (async () => {
      const root = await resolveA2uiRoot();
      if (!root) {
        return null;
      }
      const real = await fs.realpath(root);
      cachedA2uiRootReal = real;
      return real;
    })().finally(() => {
      resolvingA2uiRoot = null;
    });
  }
  return resolvingA2uiRoot;
}

export function resetA2uiRootCacheForTests() {
  cachedA2uiRootReal = undefined;
  resolvingA2uiRoot = null;
}

function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function resolveA2uiFilePath(rootReal: string, urlPath: string) {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) {
    return null;
  }

  let candidate = path.join(rootReal, rel);
  if (normalized.endsWith("/")) {
    candidate = path.join(candidate, "index.html");
  }

  try {
    const st = await fs.stat(candidate);
    if (st.isDirectory()) {
      candidate = path.join(candidate, "index.html");
    }
  } catch {
    // ignore
  }

  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  try {
    const lstat = await fs.lstat(candidate);
    if (lstat.isSymbolicLink()) {
      return null;
    }
    const real = await fs.realpath(candidate);
    if (!real.startsWith(rootPrefix)) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
}

export function injectCanvasLiveReload(html: string): string {
  const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
  function postToNode(payload) {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const name of handlerNames) {
        const iosHandler = globalThis.webkit?.messageHandlers?.[name];
        if (iosHandler && typeof iosHandler.postMessage === "function") {
          iosHandler.postMessage(raw);
          return true;
        }
        const androidHandler = globalThis[name];
        if (androidHandler && typeof androidHandler.postMessage === "function") {
          // Important: call as a method on the interface object (binding matters on Android WebView).
          androidHandler.postMessage(raw);
          return true;
        }
      }
    } catch {}
    return false;
  }
  function sendUserAction(userAction) {
    const id =
      (userAction && typeof userAction.id === "string" && userAction.id.trim()) ||
      (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    const action = { ...userAction, id };
    return postToNode({ userAction: action });
  }
  globalThis.OpenClaw = globalThis.OpenClaw ?? {};
  globalThis.OpenClaw.postMessage = postToNode;
  globalThis.OpenClaw.sendUserAction = sendUserAction;
  globalThis.openclawPostMessage = postToNode;
  globalThis.openclawSendUserAction = sendUserAction;

  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)});
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
  } catch {}
})();
</script>
`.trim();

  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx >= 0) {
    return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
  }
  return `${html}\n${snippet}\n`;
}

export async function handleA2uiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath =
    url.pathname === A2UI_PATH || url.pathname.startsWith(`${A2UI_PATH}/`) ? A2UI_PATH : undefined;
  if (!basePath) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const a2uiRootReal = await resolveA2uiRootReal();
  if (!a2uiRootReal) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("A2UI assets not found");
    return true;
  }

  const rel = url.pathname.slice(basePath.length);
  const filePath = await resolveA2uiFilePath(a2uiRootReal, rel || "/");
  if (!filePath) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  const lower = filePath.toLowerCase();
  const mime =
    lower.endsWith(".html") || lower.endsWith(".htm")
      ? "text/html"
      : ((await detectMime({ filePath })) ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");

  if (mime === "text/html") {
    const html = await fs.readFile(filePath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(injectCanvasLiveReload(html));
    return true;
  }

  res.setHeader("Content-Type", mime);
  res.end(await fs.readFile(filePath));
  return true;
}
