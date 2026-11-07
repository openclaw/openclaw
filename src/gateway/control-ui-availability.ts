import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { escapeHtml } from "../shared/html-escape.js";
import {
  applyControlUiSecurityHeaders,
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "./control-ui-csp.js";
import { isReadHttpMethod } from "./control-ui-http-utils.js";
import { classifyControlUiRequest } from "./control-ui-routing.js";
import { controlUiSessionEntryPath } from "./control-ui-session-entry-path.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isControlUiStaticAssetExtension } from "./control-ui-static.js";
import {
  getRemoteControlUiIngressContext,
  prepareGatewayIngressAttribution,
} from "./ingress-attribution.js";
import type { GatewayHttpServerOptions } from "./server-http.types.js";
import type { StartupResult } from "./server/readiness.js";

// This document must not depend on application assets or the request runtime it explains.
const recoveryScript = `(() => {
  const status = document.getElementById("recovery-status");
  let timer;
  let controller;
  let attempts = 0;
  let stopped = false;
  async function check() {
    if (controller || stopped) return;
    clearTimeout(timer);
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 6000);
    try {
      const response = await fetch(location.href, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      await response.body?.cancel();
      // Hand access/route errors back to normal document navigation (including native HTTP auth).
      const terminal = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      if (terminal || (response.status === 200 && response.headers.get("content-type")?.includes("text/html"))) {
        stopped = true;
        // Replacing an identical URL with a fragment is only a same-document navigation.
        location.reload();
        return;
      }
    } catch {
      // A failed request does not establish an update, restart, or worker failure.
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      if (!stopped) {
        status.textContent = "Not ready yet. Checking again automatically.";
        timer = setTimeout(check, Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
      }
    }
  }
  // Preserve the existing bootstrap window-drag bridge while the native embed has no app bundle.
  document.body.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.defaultPrevented || event.target !== document.body) return;
    const drag = window.webkit?.messageHandlers?.openclawWindowDrag;
    if (!drag) return;
    try { drag.postMessage({ type: "window-drag" }); event.preventDefault(); } catch {}
  });
  addEventListener("pageshow", () => { if (stopped) { stopped = false; void check(); } });
  addEventListener("online", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); controller?.abort(); });
  timer = setTimeout(check, 1000);
})();`;

/** Also usable by a disposable ingress fixture; the Gateway cannot serve a stopped listener. */
export function renderControlUiUnavailableDocument(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>OpenClaw — Temporarily unavailable</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202024;background:#f8f8f9}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:min(100%,520px);padding:40px;border:1px solid #dedee3;border-radius:20px;background:#fff;box-shadow:0 12px 40px #14141c08}
.brand{margin:0 0 36px;font-size:15px;font-weight:650;letter-spacing:-.02em}.eyebrow{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#777781}
h1{font-size:30px;line-height:1.2;letter-spacing:-.04em;margin:12px 0 16px}p{font-size:15px;line-height:1.6;color:#5f5f69;margin:12px 0}
#recovery-status{font-size:13px;min-height:42px;margin:28px 0 16px}
@media(prefers-color-scheme:dark){:root{background:#121214;color:#f4f4f5}main{background:#1b1b1f;border-color:#323237;box-shadow:none}p{color:#aaaab4}.eyebrow{color:#9999a5}}
@media(max-width:560px){body{padding:16px}main{padding:28px 24px}h1{font-size:27px}}
</style></head><body>
<main id="openclaw-maintenance"><div class="brand">OpenClaw</div><div class="eyebrow">Connection status</div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<p>This page will open automatically when it’s ready.</p>
<p id="recovery-status" role="status" aria-live="polite">Checking now — no need to reload.</p>
</main><script>${recoveryScript}</script></body></html>`;
}

function serveControlUiUnavailableDocument(
  req: IncomingMessage,
  res: ServerResponse,
  startup: Exclude<StartupResult, { status: "started" }>,
  url: URL,
  basePath: string,
): boolean {
  if (!isReadHttpMethod(req.method)) {
    return false;
  }
  const sessionEntry = url.pathname === controlUiSessionEntryPath(basePath);
  const route = classifyControlUiRequest({
    basePath,
    pathname: url.pathname,
    search: url.search,
    method: req.method,
    accept: req.headers.accept,
  });
  const relative = url.pathname.slice(basePath.length);
  if (
    !sessionEntry &&
    (!(route.kind === "redirect" || (route.kind === "serve" && route.spaFallback)) ||
      !req.headers.accept?.includes("text/html") ||
      relative.startsWith("/__openclaw__/") ||
      isControlUiStaticAssetExtension(path.extname(relative).toLowerCase()))
  ) {
    return false;
  }
  if (!canServeControlUiDuringStartup(req)) {
    return false;
  }
  const html = renderControlUiUnavailableDocument(
    startup.status === "starting" ? "OpenClaw is starting" : "OpenClaw is temporarily unavailable",
    startup.status === "starting"
      ? "The Gateway is still starting up."
      : "The Gateway is finishing its current work and isn’t accepting new connections right now.",
  );
  const ingress = getRemoteControlUiIngressContext(req);
  applyControlUiSecurityHeaders(res, ingress);
  res.statusCode = 503;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "1");
  res.setHeader("Content-Length", Buffer.byteLength(html));
  res.setHeader(
    "Content-Security-Policy",
    buildControlUiCspHeader({
      inlineScriptHashes: computeInlineScriptHashes(html),
      frameAncestors: ingress?.frameAncestors,
    }),
  );
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

/** Static startup responses retain the normal proxy-attribution rejection owner. */
function canServeControlUiDuringStartup(req: IncomingMessage): boolean {
  const gateway = getRuntimeConfigSnapshot()?.gateway;
  return (
    prepareGatewayIngressAttribution({
      req,
      trustedProxies: gateway?.trustedProxies ?? [],
      allowRealIpFallback: gateway?.allowRealIpFallback === true,
    }).kind !== "unattributable-proxy"
  );
}

/** Prefer the real app; the standalone document is only an assets-unavailable fallback. */
export async function serveControlUiStartupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  startup: Exclude<StartupResult, { status: "started" }>,
  url: URL,
  options: Pick<
    GatewayHttpServerOptions,
    "controlUiBasePath" | "controlUiEnabled" | "controlUiRoot" | "isRequestRuntimeReady"
  >,
): Promise<boolean> {
  if (startup.status !== "draining" && options.isRequestRuntimeReady?.() === true) {
    return false;
  }
  if (
    !(options.controlUiEnabled ?? getRuntimeConfigSnapshot()?.gateway?.controlUi?.enabled ?? true)
  ) {
    return false;
  }
  const basePath = normalizeControlUiBasePath(options.controlUiBasePath);
  const root = options.controlUiRoot;
  const route = classifyControlUiRequest({
    basePath,
    pathname: url.pathname,
    search: url.search,
    method: req.method,
    accept: req.headers.accept,
  });
  if (
    canServeControlUiDuringStartup(req) &&
    (route.kind === "redirect" || route.kind === "serve") &&
    !url.pathname.slice(basePath.length).startsWith("/__openclaw__/") &&
    (root?.kind === "bundled" || root?.kind === "resolved")
  ) {
    const { handleControlUiHttpRequest } = await import("./control-ui.js");
    if (
      await handleControlUiHttpRequest(req, res, {
        basePath,
        config: getRuntimeConfigSnapshot() ?? undefined,
        root,
        onUnavailableDocument: () =>
          serveControlUiUnavailableDocument(req, res, startup, url, basePath),
      })
    ) {
      return true;
    }
  }
  return serveControlUiUnavailableDocument(req, res, startup, url, basePath);
}
