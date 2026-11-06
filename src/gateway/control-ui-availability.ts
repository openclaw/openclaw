import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { escapeHtml } from "../shared/html-escape.js";
import { OPENCLAW_WORDMARK_SVG } from "../shared/openclaw-wordmark.js";
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
  // Control UI default theme tokens (ui/src/styles/base.css); the fonts are app assets, so system faces stand in.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>OpenClaw — Temporarily unavailable</title>
<style>
:root{color-scheme:light;--bg:#f8f8f8;--text-strong:#202020;--muted:#5e5e5e;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text-strong);background:var(--bg);-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1015;--text-strong:#f4f4f5;--muted:#8e8e97}}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:48px 32px;background:var(--bg)}
main{width:min(100%,480px);padding-bottom:9vh}.wordmark{display:block;height:32px;width:auto;margin:0 0 48px}
h1{margin:0;font-size:clamp(30px,3.2vw,44px);font-weight:600;line-height:1.15;letter-spacing:-.035em;text-wrap:balance}
p{margin:16px 0 0;max-width:46ch;color:var(--muted);font-size:16px;line-height:1.65}
#recovery-status{min-height:3.3em;margin-top:28px;font-size:14px}
@media(max-width:560px){body{padding:32px 24px}main{padding-bottom:6vh}.wordmark{height:28px;margin-bottom:40px}p{font-size:15px}}
</style></head><body>
<main id="openclaw-maintenance">${OPENCLAW_WORDMARK_SVG}
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)} This page will open automatically when it’s ready.</p>
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
