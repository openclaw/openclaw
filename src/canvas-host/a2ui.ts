import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SafeOpenError, openFileWithinRoot, type SafeOpenResult } from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";

export const A2UI_PATH = "/__openclaw__/a2ui";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export const CANVAS_WS_PATH = "/__openclaw__/ws";

let cachedA2uiRootReal: string | null | undefined;
let resolvingA2uiRoot: Promise<string | null> | null = null;

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from source (bun) or dist (tsc + copied assets).
    path.resolve(here, "a2ui"),
    // Running from dist without copied assets (fallback to source).
    path.resolve(here, "../../src/canvas-host/a2ui"),
    // Running from repo root.
    path.resolve(process.cwd(), "src/canvas-host/a2ui"),
    path.resolve(process.cwd(), "dist/canvas-host/a2ui"),
  ];
  if (process.execPath) {
    candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
  }

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
  if (cachedA2uiRootReal !== undefined) {
    return cachedA2uiRootReal;
  }
  if (!resolvingA2uiRoot) {
    resolvingA2uiRoot = (async () => {
      const root = await resolveA2uiRoot();
      cachedA2uiRootReal = root ? await fs.realpath(root) : null;
      return cachedA2uiRootReal;
    })();
  }
  return resolvingA2uiRoot;
}

function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function resolveA2uiFile(rootReal: string, urlPath: string): Promise<SafeOpenResult | null> {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) {
    return null;
  }

  const tryOpen = async (relative: string) => {
    try {
      return await openFileWithinRoot({ rootDir: rootReal, relativePath: relative });
    } catch (err) {
      if (err instanceof SafeOpenError) {
        return null;
      }
      throw err;
    }
  };

  if (normalized.endsWith("/")) {
    return await tryOpen(path.posix.join(rel, "index.html"));
  }

  const candidate = path.join(rootReal, rel);
  try {
    const st = await fs.lstat(candidate);
    if (st.isSymbolicLink()) {
      return null;
    }
    if (st.isDirectory()) {
      return await tryOpen(path.posix.join(rel, "index.html"));
    }
  } catch {
    // ignore
  }

  return await tryOpen(rel);
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
  const result = await resolveA2uiFile(a2uiRootReal, rel || "/");
  if (!result) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  try {
    const lower = result.realPath.toLowerCase();
    const mime =
      lower.endsWith(".html") || lower.endsWith(".htm")
        ? "text/html"
        : ((await detectMime({ filePath: result.realPath })) ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "HEAD") {
      res.setHeader("Content-Type", mime === "text/html" ? "text/html; charset=utf-8" : mime);
      res.end();
      return true;
    }

    if (mime === "text/html") {
      const buf = await result.handle.readFile({ encoding: "utf8" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(injectCanvasLiveReload(buf));
      return true;
    }

    res.setHeader("Content-Type", mime);
    res.end(await result.handle.readFile());
    return true;
  } finally {
    await result.handle.close().catch(() => {});
  }
}
