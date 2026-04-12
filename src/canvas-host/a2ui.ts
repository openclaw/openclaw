import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMime } from "../media/mime.js";
import { lowercasePreservingWhitespace } from "../shared/string-coerce.js";
import { resolveFileWithinRoot } from "./file-resolver.js";

export const A2UI_PATH = "/__openclaw__/a2ui";

export const A2UI_ACTIVITY_WS_PATH = "/__openclaw__/a2ui/ws";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export const CANVAS_WS_PATH = "/__openclaw__/ws";

let cachedA2uiRootReal: string | null | undefined;
let resolvingA2uiRoot: Promise<string | null> | null = null;
let cachedA2uiResolvedAtMs = 0;
const A2UI_ROOT_RETRY_NULL_AFTER_MS = 10_000;

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const candidates = [
    // Running from source (bun) or dist/canvas-host chunk.
    path.resolve(here, "a2ui"),
    // Running from dist root chunk (common launchd path).
    path.resolve(here, "canvas-host/a2ui"),
    path.resolve(here, "../canvas-host/a2ui"),
    // Entry path fallbacks (helps when cwd is not the repo root).
    ...(entryDir
      ? [
          path.resolve(entryDir, "a2ui"),
          path.resolve(entryDir, "canvas-host/a2ui"),
          path.resolve(entryDir, "../canvas-host/a2ui"),
        ]
      : []),
    // Running from dist without copied assets (fallback to source).
    path.resolve(here, "../../src/canvas-host/a2ui"),
    path.resolve(here, "../src/canvas-host/a2ui"),
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
  const nowMs = Date.now();
  if (
    cachedA2uiRootReal !== undefined &&
    (cachedA2uiRootReal !== null || nowMs - cachedA2uiResolvedAtMs < A2UI_ROOT_RETRY_NULL_AFTER_MS)
  ) {
    return cachedA2uiRootReal;
  }
  if (!resolvingA2uiRoot) {
    resolvingA2uiRoot = (async () => {
      const root = await resolveA2uiRoot();
      cachedA2uiRootReal = root ? await fs.realpath(root) : null;
      cachedA2uiResolvedAtMs = Date.now();
      resolvingA2uiRoot = null;
      return cachedA2uiRootReal;
    })();
  }
  return resolvingA2uiRoot;
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

  const createDiscordActivityHelper = () => {
    const params = new URLSearchParams(location.search);
    const host = String(location.host || "").toLowerCase();
    const isDiscordHost = host.endsWith(".discordsays.com");
    const hasLaunchContext = ["instance_id", "frame_id", "platform"].some((key) => {
      const raw = params.get(key);
      return typeof raw === "string" && raw.trim().length > 0;
    });
    const isActivityContext = isDiscordHost || hasLaunchContext;
    const defaultClientId = (() => {
      const hostPrefix = String(location.hostname || "").split(".")[0] || "";
      return /^\d{17,22}$/.test(hostPrefix) ? hostPrefix : "";
    })();

    const state = {
      isActivityContext,
      isDiscordHost,
      hasLaunchContext,
      clientId: defaultClientId || undefined,
      sdk: undefined,
      ready: false,
      error: undefined,
      _loadPromise: undefined,
    };

    const resolveClientId = (override) => {
      const trimmed = typeof override === "string" ? override.trim() : "";
      if (trimmed) {
        return trimmed;
      }
      return state.clientId;
    };

    const load = async (options = {}) => {
      if (!state.isActivityContext) {
        state.error = "Not running inside Discord Activity context.";
        return null;
      }
      if (state.ready && state.sdk) {
        return state.sdk;
      }
      if (!state._loadPromise) {
        state._loadPromise = (async () => {
          try {
            const moduleFromGlobal = globalThis.DiscordSDK ? { DiscordSDK: globalThis.DiscordSDK } : null;
            let sdkModule = moduleFromGlobal;
            if (!sdkModule) {
              try {
                sdkModule = await import("https://cdn.jsdelivr.net/npm/@discord/embedded-app-sdk/+esm");
              } catch {
                sdkModule = await import("https://esm.sh/@discord/embedded-app-sdk");
              }
            }
            const DiscordSDK = sdkModule?.DiscordSDK;
            if (typeof DiscordSDK !== "function") {
              throw new Error("DiscordSDK constructor missing from @discord/embedded-app-sdk");
            }
            const clientId = resolveClientId(options.clientId);
            if (!clientId) {
              throw new Error("Unable to resolve Discord client id from hostname; pass clientId explicitly.");
            }
            const sdk = new DiscordSDK(clientId);
            const readyTimeoutMs =
              typeof options.readyTimeoutMs === "number" && Number.isFinite(options.readyTimeoutMs)
                ? Math.max(250, options.readyTimeoutMs)
                : 6000;
            await Promise.race([
              sdk.ready(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("DiscordSDK.ready() timed out")), readyTimeoutMs),
              ),
            ]);
            state.clientId = clientId;
            state.sdk = sdk;
            state.ready = true;
            state.error = undefined;
            return sdk;
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
            state.ready = false;
            state.sdk = undefined;
            throw error;
          }
        })();
      }
      return await state._loadPromise;
    };

    const requireActivityContext = async (options = {}) => {
      if (!state.isActivityContext) {
        state.error = "Discord Activity context required.";
        return false;
      }
      if (options.requireReady === false) {
        return true;
      }
      try {
        await load(options);
        return true;
      } catch {
        return false;
      }
    };

    const requireSdk = async (options = {}) => {
      const sdk = await load(options);
      if (!sdk) {
        throw new Error("Discord Activity SDK unavailable in this context.");
      }
      return sdk;
    };

    const runCommand = async (name, params = undefined, options = {}) => {
      const sdk = await requireSdk(options);
      const commands = sdk && sdk.commands ? sdk.commands : undefined;
      const fn = commands ? commands[name] : undefined;
      if (typeof fn !== "function") {
        throw new Error('Discord SDK command unavailable: ' + String(name));
      }
      return params === undefined ? await fn.call(commands) : await fn.call(commands, params);
    };

    const commands = {
      run: runCommand,
      openExternalLink: async (params, options = {}) => {
        const payload =
          typeof params === "string" ? { url: params } : params && typeof params === "object" ? params : {};
        return await runCommand("openExternalLink", payload, options);
      },
      openInviteDialog: async (params = {}, options = {}) =>
        await runCommand("openInviteDialog", params, options),
      openShareMomentDialog: async (params = {}, options = {}) =>
        await runCommand("openShareMomentDialog", params, options),
      encourageHardwareAcceleration: async (params = {}, options = {}) =>
        await runCommand("encourageHardwareAcceleration", params, options),
      getChannel: async (options = {}) => await runCommand("getChannel", undefined, options),
      getInstanceConnectedParticipants: async (options = {}) =>
        await runCommand("getInstanceConnectedParticipants", undefined, options),
    };

    const oauth = {
      authorize: async (params = {}, options = {}) => await runCommand("authorize", params, options),
      authenticate: async (params = {}, options = {}) =>
        await runCommand("authenticate", params, options),
      exchangeAndAuthenticate: async (params = {}) => {
        const authorizeResult = await runCommand("authorize", params.authorize ?? {}, params.load ?? {});
        const code =
          authorizeResult && typeof authorizeResult.code === "string"
            ? authorizeResult.code.trim()
            : "";
        if (!code) {
          throw new Error("Discord authorize did not return an OAuth code.");
        }
        if (typeof params.exchange !== "function") {
          throw new Error("exchangeAndAuthenticate requires an exchange({ code, authorizeResult }) callback.");
        }
        const tokenPayload = await params.exchange({ code, authorizeResult });
        if (!tokenPayload || typeof tokenPayload !== "object") {
          throw new Error("OAuth exchange callback must return an auth payload object.");
        }
        return await runCommand("authenticate", tokenPayload, params.load ?? {});
      },
    };

    return {
      get isActivityContext() {
        return state.isActivityContext;
      },
      get isDiscordHost() {
        return state.isDiscordHost;
      },
      get hasLaunchContext() {
        return state.hasLaunchContext;
      },
      get clientId() {
        return state.clientId;
      },
      get sdk() {
        return state.sdk;
      },
      get ready() {
        return state.ready;
      },
      get error() {
        return state.error;
      },
      load,
      requireActivityContext,
      commands,
      oauth,
    };
  };

  if (!globalThis.OpenClaw.discord) {
    globalThis.OpenClaw.discord = createDiscordActivityHelper();
  }
  globalThis.openclawDiscord = globalThis.OpenClaw.discord;

  try {
    const cap = new URLSearchParams(location.search).get("oc_cap");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const capQuery = cap ? "?oc_cap=" + encodeURIComponent(cap) : "";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)} + capQuery);
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
  } catch {}
})();
</script>
`.trim();

  const idx = lowercasePreservingWhitespace(html).lastIndexOf("</body>");
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
  const result = await resolveFileWithinRoot(a2uiRootReal, rel || "/");
  if (!result) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  try {
    const lower = lowercasePreservingWhitespace(result.realPath);
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
