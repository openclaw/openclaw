import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createAuthGuardedHandler(handler: PluginHttpRouteHandler): PluginHttpRouteHandler {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return;
    }
    // Lazy-load config and auth to avoid circular dependency issues at import time.
    const { loadConfig } = await import("../config/config.js");
    const { resolveGatewayAuth } = await import("../gateway/auth.js");
    const config = loadConfig();
    const resolvedAuth = resolveGatewayAuth({ authConfig: config.gateway?.auth });
    if (!resolvedAuth.token || !safeEqual(token, resolvedAuth.token)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return;
    }
    return handler(req, res);
  };
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
  /** When true, reject requests without valid gateway auth token. */
  requireAuth?: boolean;
}): () => void {
  const registry = params.registry ?? requireActivePluginRegistry();
  const routes = registry.httpRoutes ?? [];
  registry.httpRoutes = routes;

  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  if (!normalizedPath) {
    params.log?.(`plugin: webhook path missing${suffix}`);
    return () => {};
  }

  if (routes.some((entry) => entry.path === normalizedPath)) {
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(`plugin: webhook path ${normalizedPath} already registered${suffix}${pluginHint}`);
    return () => {};
  }

  const finalHandler = params.requireAuth
    ? createAuthGuardedHandler(params.handler)
    : params.handler;

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: finalHandler,
    pluginId: params.pluginId,
    source: params.source,
  };
  routes.push(entry);

  return () => {
    const index = routes.indexOf(entry);
    if (index >= 0) {
      routes.splice(index, 1);
    }
  };
}
