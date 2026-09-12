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
