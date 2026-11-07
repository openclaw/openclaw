import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
import { renderControlUiUnavailableDocument } from "./control-ui-unavailable-document.js";
import {
  getRemoteControlUiIngressContext,
  prepareGatewayIngressAttribution,
} from "./ingress-attribution.js";
import type { GatewayHttpServerOptions } from "./server-http.types.js";
import type { StartupResult } from "./server/readiness.js";

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
