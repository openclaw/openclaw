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

// The sidebar header carries the wordmark; its own gradient id keeps the phone header copy
// painting where the sidebar is hidden, and the sidebar's aria-hidden covers its label.
const SIDEBAR_WORDMARK_SVG = OPENCLAW_WORDMARK_SVG.replace(
  'class="wordmark" role="img" aria-label="OpenClaw"',
  'class="side-brand"',
).replaceAll("openclaw-wordmark-shell", "openclaw-sidebar-shell");

// Decorative copy of the Control UI's disconnected shell, so the app replaces it without a jump.
const SHELL_SIDEBAR = `<aside class="sidebar" aria-hidden="true" data-window-drag><div class="rail" data-window-drag>
<span class="rail-slot"><span class="rail-disc"></span></span>
<span class="rail-create"><span class="rail-new">${railIcon('<path d="M5 12h14M12 5v14"/>')}</span></span>
<span class="rail-slot">${railIcon('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>')}</span>
<span class="rail-slot is-current">${railIcon('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>')}</span>
<span class="rail-slot">${railIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>')}</span>
<span class="rail-slot">${railIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}</span>
<span class="rail-bottom"><span class="rail-slot is-idle">${railIcon('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>')}</span>
<span class="rail-slot is-idle">${railIcon('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="m5.45 5.11-3.45 6.89v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89a2 2 0 0 0-1.79-1.11h-9.52a2 2 0 0 0-1.79 1.11z"/>')}</span>
<span class="rail-slot rail-avatar"><span></span><span></span></span></span>
</div><div class="side" data-window-drag>${SIDEBAR_WORDMARK_SVG}<span class="skeleton-rows"><span><span></span><span></span></span><span><span></span><span></span></span><span><span></span><span></span></span><span><span></span><span></span></span></span></div></aside>`;

/** Also usable by a disposable ingress fixture; the Gateway cannot serve a stopped listener. */
export function renderControlUiUnavailableDocument(title: string): string {
  // Control UI default theme tokens and geometry (ui/src/styles); the fonts are app assets, so system faces stand in.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>OpenClaw — Temporarily unavailable</title>
<style>
:root{color-scheme:light;--bg:#f8f8f8;--text:#353535;--text-strong:#202020;--muted:#5e5e5e;--rail:#f0f0f0;--rail-edge:#ebebeb;--side:#f4f4f4;--side-edge:#ededed;--icon:rgb(53 53 53/.6);--current:#e5e5e5;--current-icon:#202020;--accent:#bd4531;--divider:rgb(0 0 0/.13);--placeholder:rgb(94 94 94/.16);--placeholder-strong:rgb(94 94 94/.2);--skeleton:rgb(94 94 94/.1);--skeleton-disc:rgb(94 94 94/.12);--presence:#92400e;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.01em;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1015;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8e8e97;--rail:#15171c;--rail-edge:#1f2126;--side:#121419;--side-edge:#1d1f24;--icon:rgb(188 188 192/.48);--current:#222429;--current-icon:#f4f4f5;--accent:#ff5c5c;--divider:rgb(255 255 255/.14);--placeholder:rgb(142 142 151/.16);--placeholder-strong:rgb(142 142 151/.2);--skeleton:rgb(142 142 151/.1);--skeleton-disc:rgb(142 142 151/.12);--presence:#f59e0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg)}
.shell{display:flex;min-height:100svh}
.sidebar{display:flex;flex:none;position:sticky;top:0;height:100svh}
.rail{display:flex;flex-direction:column;align-items:center;gap:8px;width:52px;padding:4px 4px 8px;background:var(--rail);border-right:1px solid var(--rail-edge)}
.rail-slot{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:12.5px;color:var(--icon)}
.rail-slot svg,.rail-new svg{display:block;width:19px;height:19px}.rail-disc{width:26px;height:26px;border-radius:50%;background:var(--placeholder-strong)}
.rail-slot.is-current{background:color-mix(in srgb,var(--current) 50%,transparent);color:color-mix(in srgb,var(--current-icon) 60%,transparent)}.rail-slot.is-idle{opacity:.4}
.rail-create{display:flex;justify-content:center;width:36px;padding-bottom:8px;border-bottom:1px solid var(--divider)}
.rail-new{display:grid;place-items:center;width:30px;height:30px;margin:3px;border-radius:12.5px;background:var(--skeleton-disc);color:var(--icon)}
.rail-bottom{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.rail-avatar{position:relative}.rail-avatar>span{position:absolute;border-radius:50%}
.rail-avatar>:first-child{left:3px;top:3px;width:28px;height:28px;background:var(--placeholder)}
.rail-avatar>:last-child{left:23px;top:23px;width:12px;height:12px;background:var(--presence);border:2px solid var(--rail)}
.side{width:258px;padding:12px 4px 8px;background:var(--side);border-right:1px solid var(--side-edge)}
/* Control UI session-row metrics: 32px rows, 18px avatar centered 24px in, title at 42px. */
.side-brand{display:block;width:auto;height:20px;margin-left:8.6px;color:var(--text-strong)}
.skeleton-rows{display:grid;margin-top:16px}.skeleton-rows>span{display:flex;align-items:center;gap:9px;height:32px;padding:0 8px 0 11px}
.skeleton-rows>span>span{height:10px;border-radius:9999px;background:var(--skeleton)}
.skeleton-rows>span>:first-child{flex:none;width:18px;height:18px;border-radius:50%;background:var(--skeleton-disc)}
.skeleton-rows>span>:last-child{width:68%}.skeleton-rows>:nth-child(2)>:last-child{width:50%}.skeleton-rows>:nth-child(3)>:last-child{width:78%}.skeleton-rows>:nth-child(4)>:last-child{width:58%}
.content{position:relative;display:flex;flex-direction:column;flex:1;min-width:0}
.topbar{display:none}
.wordmark{display:block;width:140px;height:32px;color:var(--text-strong)}
main{position:relative;flex:1;min-height:100svh}
/* Every status page shares one anatomy: a left-aligned column whose title holds a fixed height a little above centre. */
.body{position:absolute;top:34%;left:50%;width:min(440px,calc(100% - 48px));transform:translateX(-50%)}
h1{position:relative;margin:0;color:var(--text-strong);font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;text-wrap:balance}
.spin{position:absolute;top:7px;left:-26px;color:var(--accent)}.spin svg{display:block;width:14px;height:14px;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
p{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:21px;text-wrap:pretty}
@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape){.sidebar{display:none}.content{padding:0 4px}.topbar{display:flex;align-items:flex-start;justify-content:center;padding:14.5px 12px 0}main{min-height:calc(100svh - 64px)}.body{top:30%;left:24px;right:24px;width:auto;transform:none}h1{font-size:20px;line-height:26px}.spin{display:none}}
@media(prefers-reduced-motion:reduce){.spin svg{animation-duration:3s}}
</style></head><body>
<div class="shell" data-window-drag>${SHELL_SIDEBAR}
<div class="content" data-window-drag><header class="topbar" data-window-drag>${OPENCLAW_WORDMARK_SVG}</header>
<main id="openclaw-maintenance" data-window-drag><div class="body" data-window-drag>
<h1><span class="spin" aria-hidden="true"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="6.25" opacity=".2"/><circle cx="7" cy="7" r="6.25" pathLength="100" stroke-dasharray="26 74" stroke-linecap="round"/></svg></span>${escapeHtml(title)}</h1>
<p role="status" aria-live="polite">Hang on while the Gateway gets ready.</p>
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
    startup.status === "starting" ? "OpenClaw is starting" : "OpenClaw is temporarily unavailable",
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
