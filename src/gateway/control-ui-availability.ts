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
        timer = setTimeout(check, Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
      }
    }
  }
  // Preserve the existing bootstrap window-drag bridge while the native embed has no app bundle.
  document.body.addEventListener("mousedown", (event) => {
    const target = event.target;
    const empty = target === document.body || (target instanceof Element && target.hasAttribute("data-window-drag"));
    if (event.button !== 0 || event.defaultPrevented || !empty) return;
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

// Lucide icons at the Control UI rail size; the strokes follow each slot's color.
function railIcon(body: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// The Control UI rail mark (ui/src/components/solid/icon.tsx "lobster").
const RAIL_MARK_SVG = `<svg viewBox="0 0 120 120" fill="none"><defs><linearGradient id="openclaw-rail-shell" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#openclaw-rail-shell)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#openclaw-rail-shell)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#openclaw-rail-shell)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg>`;

// Decorative copy of the Control UI's disconnected shell, so the app replaces it without a jump.
const SHELL_SIDEBAR = `<aside class="sidebar" aria-hidden="true" data-window-drag><div class="rail" data-window-drag>
<span class="rail-slot rail-mark">${RAIL_MARK_SVG}</span>
<span class="rail-create"><span class="rail-new">${railIcon('<path d="M5 12h14M12 5v14"/>')}</span></span>
<span class="rail-slot">${railIcon('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>')}</span>
<span class="rail-slot is-current">${railIcon('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>')}</span>
<span class="rail-slot">${railIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>')}</span>
<span class="rail-slot">${railIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}</span>
<span class="rail-bottom"><span class="rail-slot is-idle">${railIcon('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>')}</span>
<span class="rail-slot is-idle">${railIcon('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="m5.45 5.11-3.45 6.89v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89a2 2 0 0 0-1.79-1.11h-9.52a2 2 0 0 0-1.79 1.11z"/>')}</span>
<span class="rail-slot rail-avatar"><span></span><span></span></span></span>
</div><div class="side" data-window-drag><span class="skeleton-heading"></span><span class="skeleton-rows"><span><span></span><span></span></span><span><span></span><span></span></span><span><span></span><span></span></span><span><span></span><span></span></span></span></div></aside>`;

/** Also usable by a disposable ingress fixture; the Gateway cannot serve a stopped listener. */
export function renderControlUiUnavailableDocument(title: string): string {
  // Control UI default theme tokens and geometry (ui/src/styles); the fonts are app assets, so system faces stand in.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>OpenClaw — Temporarily unavailable</title>
<style>
:root{color-scheme:light;--bg:#f8f8f8;--text:#353535;--text-strong:#202020;--muted:#5e5e5e;--rail:#f0f0f0;--rail-edge:#ebebeb;--side:#f4f4f4;--side-edge:#ededed;--icon:rgb(53 53 53/.6);--current:#e5e5e5;--current-icon:#202020;--accent:#bd4531;--on-accent:#fff;--divider:rgb(0 0 0/.13);--placeholder:rgb(94 94 94/.16);--skeleton:rgb(94 94 94/.09);--skeleton-heading:rgb(94 94 94/.12);--presence:#92400e;--tile:#fbfbfb;--tile-edge:#eaeaea;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.01em;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1015;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8e8e97;--rail:#15171c;--rail-edge:#1f2126;--side:#121419;--side-edge:#1d1f24;--icon:rgb(188 188 192/.48);--current:#222429;--current-icon:#f4f4f5;--accent:#ff5c5c;--on-accent:#0e1015;--divider:rgb(255 255 255/.14);--placeholder:rgb(142 142 151/.16);--skeleton:rgb(142 142 151/.09);--skeleton-heading:rgb(142 142 151/.12);--presence:#f59e0b;--tile:#1c1e23;--tile-edge:#23252a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg)}
.shell{display:flex;min-height:100svh}
.sidebar{display:flex;flex:none;position:sticky;top:0;height:100svh}
.rail{display:flex;flex-direction:column;align-items:center;gap:8px;width:52px;padding:4px 4px 8px;background:var(--rail);border-right:1px solid var(--rail-edge)}
.rail-slot{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:12.5px;color:var(--icon)}
.rail-slot svg,.rail-new svg{display:block;width:19px;height:19px}.rail-mark svg{width:24px;height:24px}
.rail-slot.is-current{background:var(--current);color:var(--current-icon)}.rail-slot.is-idle{opacity:.4}
.rail-create{display:flex;justify-content:center;width:36px;padding-bottom:8px;border-bottom:1px solid var(--divider)}
.rail-new{display:grid;place-items:center;width:30px;height:30px;margin:3px;border-radius:12.5px;background:var(--accent);color:var(--on-accent);opacity:.4}
.rail-bottom{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.rail-avatar{position:relative}.rail-avatar>span{position:absolute;border-radius:50%}
.rail-avatar>:first-child{left:3px;top:3px;width:28px;height:28px;background:var(--placeholder)}
.rail-avatar>:last-child{left:23px;top:23px;width:12px;height:12px;background:var(--presence);border:2px solid var(--rail)}
.side{width:258px;padding:18px 22px 8px;background:var(--side);border-right:1px solid var(--side-edge)}
.skeleton-heading{display:block;width:60px;height:7px;border-radius:4px;background:var(--skeleton-heading)}
.skeleton-rows{display:grid;gap:22px;margin-top:34px}.skeleton-rows>span{display:flex;align-items:center;gap:10px;height:12px}
.skeleton-rows>span>span{height:6px;border-radius:4px;background:var(--skeleton)}
.skeleton-rows>span>:first-child{flex:none;width:9px;height:9px;border-radius:50%}
.skeleton-rows>span>:last-child{width:70%}.skeleton-rows>:nth-child(2)>:last-child{width:52%}.skeleton-rows>:nth-child(3)>:last-child{width:79%}.skeleton-rows>:nth-child(4)>:last-child{width:61%}
.content{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;padding:0 20px}
.topbar{position:absolute;inset:0 0 auto;display:grid;grid-template-columns:min(100%,480px);justify-content:center;height:53px;padding:8px 52px 0}
.wordmark{display:block;width:140px;height:32px;margin-top:6.5px;color:var(--text-strong)}
main{display:grid;place-items:center;flex:1;min-height:100svh;padding:48px 32px}
.body{width:min(100%,480px);padding-bottom:9vh}
.busy{display:grid;place-items:center;width:48px;height:48px;margin-bottom:28px;border:1px solid var(--tile-edge);border-radius:14px;background:var(--tile);color:var(--accent)}
.busy svg{display:block;width:22px;height:22px;animation:spin 1.6s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
h1{margin:0;font-size:clamp(24px,2.5vw,32px);font-weight:600;line-height:1.2;letter-spacing:-.035em;text-wrap:balance}
p{margin:16px 0 0;max-width:42ch;color:var(--muted);font-size:12px;line-height:1.7}
/* Holds the empty action row height of the app view, so the block sits where the app draws it. */
.status{margin:4px 0 calc(64px - 1.7em)}
@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape){.sidebar{display:none}.content{padding:0 4px}.topbar{position:static;display:flex;padding:8px 12px 0}main{min-height:calc(100svh - 64px);margin-top:11px}}
@media(max-width:640px){main{padding:32px 24px}.body{padding-bottom:6vh}}
@media(prefers-reduced-motion:reduce){.busy svg{animation:none}}
</style></head><body>
<div class="shell" data-window-drag>${SHELL_SIDEBAR}
<div class="content" data-window-drag><header class="topbar" data-window-drag>${OPENCLAW_WORDMARK_SVG}</header>
<main id="openclaw-maintenance" data-window-drag><div class="body" data-window-drag>
<div class="busy" aria-hidden="true"><svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="10" opacity=".2"/><circle cx="11" cy="11" r="10" pathLength="100" stroke-dasharray="26 74" stroke-linecap="round"/></svg></div>
<h1>${escapeHtml(title)}</h1><p>Your workspace opens when it’s ready.</p>
<p class="status" role="status" aria-live="polite">Checking now — no need to reload.</p>
</div></main></div></div><script>${recoveryScript}</script></body></html>`;
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
    startup.status === "starting" ? "OpenClaw is waking up" : "OpenClaw is temporarily unavailable",
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
