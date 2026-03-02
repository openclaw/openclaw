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

export type RegisterPluginWebhookRouteResult = {
  ok: boolean;
  unregister: () => void;
};

const sharedWebhookRouteRefCounts = new WeakMap<
  PluginRegistry,
  Map<PluginHttpRouteRegistration, number>
>();

function getSharedWebhookRouteRefCounts(
  registry: PluginRegistry,
): Map<PluginHttpRouteRegistration, number> {
  let counts = sharedWebhookRouteRefCounts.get(registry);
  if (!counts) {
    counts = new Map<PluginHttpRouteRegistration, number>();
    sharedWebhookRouteRefCounts.set(registry, counts);
  }
  return counts;
}

function createIdempotentUnregister(action: () => void): () => void {
  let unregistered = false;
  return () => {
    if (unregistered) {
      return;
    }
    unregistered = true;
    action();
  };
}

type RegisterPluginHttpRouteParams = {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  kind?: OpenClawPluginHttpRouteKind;
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
};

function registerPluginHttpRouteInternal(
  params: RegisterPluginHttpRouteParams,
): RegisterPluginWebhookRouteResult {
  const registry = params.registry ?? requireActivePluginRegistry();
  const routes = registry.httpRoutes ?? [];
  registry.httpRoutes = routes;

  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  const kind = params.kind ?? "default";
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  if (!normalizedPath) {
    params.log?.(`plugin: webhook path missing${suffix}`);
    return { ok: false, unregister: () => {} };
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
    return { ok: false, unregister: () => {} };
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
      const counts = getSharedWebhookRouteRefCounts(registry);
      counts.set(existing, (counts.get(existing) ?? 1) + 1);
      params.log?.(`plugin: reusing shared webhook path ${normalizedPath}${suffix}${pluginHint}`);
      return {
        ok: true,
        unregister: createIdempotentUnregister(() => {
          const current = counts.get(existing);
          if (current === undefined) {
            return;
          }
          if (current > 1) {
            counts.set(existing, current - 1);
            return;
          }
          counts.delete(existing);
          const index = routes.indexOf(existing);
          if (index >= 0) {
            routes.splice(index, 1);
          }
        }),
      };
    } else {
      registry.diagnostics.push({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `http route already registered: ${normalizedPath}`,
      });
      params.log?.(`plugin: refusing duplicate route ${normalizedPath}${suffix}`);
      return { ok: false, unregister: () => {} };
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
  if (kind === "webhook") {
    getSharedWebhookRouteRefCounts(registry).set(entry, 1);
  }

  return {
    ok: true,
    unregister: createIdempotentUnregister(() => {
      if (kind === "webhook") {
        const counts = getSharedWebhookRouteRefCounts(registry);
        const current = counts.get(entry);
        if (current === undefined) {
          return;
        }
        if (current > 1) {
          counts.set(entry, current - 1);
          return;
        }
        counts.delete(entry);
      }
      const index = routes.indexOf(entry);
      if (index >= 0) {
        routes.splice(index, 1);
      }
    }),
  };
}

export function registerPluginHttpRoute(params: RegisterPluginHttpRouteParams): () => void {
  return registerPluginHttpRouteInternal(params).unregister;
}

export function registerPluginWebhookRoute(
  params: Omit<RegisterPluginHttpRouteParams, "kind">,
): RegisterPluginWebhookRouteResult {
  return registerPluginHttpRouteInternal({ ...params, kind: "webhook" });
}
