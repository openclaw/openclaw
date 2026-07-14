// Tracks plugin HTTP registry context for current async execution.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginHttpRouteRegistry } from "./runtime.js";

type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

type PluginHttpRouteConflictPolicy = "ignore" | "throw";

function rejectRouteRegistration(params: {
  message: string;
  policy?: PluginHttpRouteConflictPolicy;
  log?: (message: string) => void;
}): () => void {
  params.log?.(params.message);
  if (params.policy === "throw") {
    throw new Error(params.message);
  }
  return () => {};
}

const pluginHttpRouteRegistryScope = new AsyncLocalStorage<PluginRegistry>();

export function withPluginHttpRouteRegistry<T>(registry: PluginRegistry, run: () => T): T {
  return pluginHttpRouteRegistryScope.run(registry, run);
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  replaceExisting?: boolean;
  /** Preserve the legacy no-op default, or fail startup when this route is unavailable. */
  conflictPolicy?: PluginHttpRouteConflictPolicy;
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void {
  const registry =
    params.registry ??
    pluginHttpRouteRegistryScope.getStore() ??
    requireActivePluginHttpRouteRegistry();
  const routes = registry.httpRoutes ?? [];
  registry.httpRoutes = routes;

  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  if (!normalizedPath) {
    return rejectRouteRegistration({
      message: `plugin: webhook path missing${suffix}`,
      policy: params.conflictPolicy,
      log: params.log,
    });
  }

  const routeMatch = params.match ?? "exact";
  const overlappingRoute = findOverlappingPluginHttpRoute(routes, {
    path: normalizedPath,
    match: routeMatch,
  });
  if (overlappingRoute && overlappingRoute.auth !== params.auth) {
    return rejectRouteRegistration({
      message:
        `plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; ` +
        `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
        `owned by ${overlappingRoute.pluginId ?? "unknown-plugin"} (${overlappingRoute.source ?? "unknown-source"})`,
      policy: params.conflictPolicy,
      log: params.log,
    });
  }
  const existingIndex = routes.findIndex(
    (entry) => entry.path === normalizedPath && entry.match === routeMatch,
  );
  if (existingIndex >= 0) {
    const existing = routes[existingIndex];
    if (!existing) {
      return rejectRouteRegistration({
        message: `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}`,
        policy: params.conflictPolicy,
        log: params.log,
      });
    }
    if (!params.replaceExisting) {
      return rejectRouteRegistration({
        message: `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`,
        policy: params.conflictPolicy,
        log: params.log,
      });
    }
    if (existing.pluginId && params.pluginId && existing.pluginId !== params.pluginId) {
      return rejectRouteRegistration({
        message: `plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId}`,
        policy: params.conflictPolicy,
        log: params.log,
      });
    }
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
    routes.splice(existingIndex, 1);
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: params.handler,
    auth: params.auth,
    match: routeMatch,
    ...(params.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
      : {}),
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
