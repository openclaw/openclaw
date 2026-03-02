import type { IncomingMessage, ServerResponse } from "node:http";
import { isCoreOwnedHttpPath } from "../gateway/server/core-http-paths.js";
import { normalizePluginHttpPath } from "./http-path.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginRegistry } from "./runtime.js";
import type { OpenClawPluginHttpRouteKind } from "./types.js";

export type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  kind?: OpenClawPluginHttpRouteKind;
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
  const kind = params.kind ?? "default";
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  if (!normalizedPath) {
    params.log?.(`plugin: webhook path missing${suffix}`);
    return () => {};
  }

  if (kind === "webhook" && isCoreOwnedHttpPath(normalizedPath)) {
    registry.diagnostics.push({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: `http webhook route conflicts with core path: ${normalizedPath}`,
    });
    params.log?.(
      `plugin: refusing webhook path ${normalizedPath}${suffix} because it conflicts with a core route`,
    );
    return () => {};
  }

  const existingIndex = routes.findIndex((entry) => entry.path === normalizedPath);
  if (existingIndex >= 0) {
    const existing = routes[existingIndex];
    if (
      existing?.kind === "webhook" &&
      kind === "webhook" &&
      existing.pluginId === params.pluginId
    ) {
      const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
      params.log?.(`plugin: replacing stale webhook path ${normalizedPath}${suffix}${pluginHint}`);
      routes.splice(existingIndex, 1);
    } else {
      registry.diagnostics.push({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `http route already registered: ${normalizedPath}`,
      });
      params.log?.(`plugin: refusing duplicate route ${normalizedPath}${suffix}`);
      return () => {};
    }
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: params.handler,
    kind,
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
