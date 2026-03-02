import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizePluginHttpPath } from "./http-path.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth?: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
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

  const routeMatch = params.match ?? "exact";
  const existingIndex = routes.findIndex(
    (entry) => entry.path === normalizedPath && entry.match === routeMatch,
  );
  if (existingIndex >= 0) {
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
    routes.splice(existingIndex, 1);
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: params.handler,
    auth: params.auth ?? "gateway",
    match: routeMatch,
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
