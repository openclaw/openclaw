import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";

export type ModelCatalogReadScope = Pick<
  ModelsListParams,
  "agentId" | "sessionKey" | "authProfileId"
>;

export type ModelCatalogClient = Pick<GatewayBrowserClient, "request">;
export type ModelCatalogRequest = {
  refresh: boolean;
  controller?: AbortController;
  promise: Promise<ModelCatalogResult>;
  subscribers: Set<object>;
};
export type ModelCatalogEntry = {
  scope: ModelCatalogReadScope;
  result?: ModelCatalogResult;
  expiresAt?: number;
  pending: Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequest>;
};

// Application lifecycle invalidation must not eagerly load catalog readers or presentation.
export const modelCatalogCache = new WeakMap<ModelCatalogClient, Map<string, ModelCatalogEntry>>();

const MAX_CACHED_MODEL_CATALOGS = 64;

export function trimModelCatalogCache(cache: Map<string, ModelCatalogEntry>): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_MODEL_CATALOGS) {
      return;
    }
    if (entry.pending.size === 0) {
      cache.delete(key);
    }
  }
}

export function modelCatalogParams(options: ModelsListParams): ModelsListParams {
  const { agentId, view = "configured", ...params } = options;
  return { view, ...params, ...(agentId === undefined ? {} : { agentId: agentId.trim() }) };
}

export function modelCatalogKey(params: ModelsListParams): string {
  const { refresh: _refresh, ...projection } = params;
  return JSON.stringify(
    Object.entries(projection)
      .filter(([, value]) => value !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function publishModelCatalogResult(
  entry: ModelCatalogEntry,
  result: ModelCatalogResult,
): void {
  entry.result = result;
  // Cooldown expiry changes readiness without publishing a new Gateway generation.
  entry.expiresAt = result.models.reduce(
    (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
    Infinity,
  );
}

export function seedModelCatalogCache(
  client: ModelCatalogClient,
  scope: ModelCatalogReadScope,
  result: ModelCatalogResult,
): void {
  if (result.refreshFailed) {
    return;
  }
  const params = modelCatalogParams(scope);
  const cache = modelCatalogCache.get(client) ?? new Map<string, ModelCatalogEntry>();
  const entry: ModelCatalogEntry = { scope: params, pending: new Map() };
  publishModelCatalogResult(entry, result);
  cache.set(modelCatalogKey(params), entry);
  trimModelCatalogCache(cache);
  modelCatalogCache.set(client, cache);
}

/** Retire display copies and sharing eligibility before any consumer starts its next read. */
export function invalidateModelCatalogCache(
  client: ModelCatalogClient,
  scope?: ModelCatalogReadScope & { sessionsOnly?: boolean },
): void {
  if (!scope) {
    modelCatalogCache.delete(client);
    return;
  }
  const cache = modelCatalogCache.get(client);
  if (!cache) {
    return;
  }
  for (const [key, entry] of cache) {
    if (
      (!scope.sessionsOnly || entry.scope.sessionKey !== undefined) &&
      (scope.agentId === undefined ||
        entry.scope.agentId === undefined ||
        entry.scope.agentId === scope.agentId.trim()) &&
      (scope.sessionKey === undefined || entry.scope.sessionKey === scope.sessionKey) &&
      (scope.authProfileId === undefined || entry.scope.authProfileId === scope.authProfileId)
    ) {
      cache.delete(key);
    }
  }
}
