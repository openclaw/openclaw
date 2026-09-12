import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import {
  invalidateModelCatalogCache,
  modelCatalogCache,
  type ModelCatalogClient,
  type ModelCatalogEntry,
  type ModelCatalogRequest,
} from "./model-catalog-cache.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  refreshFailed?: boolean;
  pendingProviders?: readonly string[];
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

export function resolveModelCatalogState(
  result: Pick<ModelCatalogResult, "models" | "refreshFailed"> &
    Pick<ChatModelCatalogState, "pendingProviders">,
  {
    connected = true,
    loading = false,
    error = null,
  }: {
    connected?: boolean;
    loading?: boolean;
    error?: string | null;
  } = {},
): ChatModelCatalogState {
  return {
    hasSnapshot: result.models.length > 0 || (!loading && !error),
    refreshFailed: result.refreshFailed,
    pendingProviders: result.pendingProviders,
    status: !connected ? "offline" : error ? "error" : loading ? "loading" : "ready",
  };
}

export function modelCatalogRefreshError(
  result: ModelCatalogResult,
  failureMessage?: string,
): string | null {
  return result.refreshFailed
    ? (failureMessage ??
        t(
          result.models.length
            ? "chat.modelControls.modelsRefreshFailed"
            : "chat.modelControls.modelsUnavailable",
        ))
    : null;
}

const MAX_CACHED_MODEL_CATALOGS = 64;

function trimModelCatalogCache(cache: Map<string, ModelCatalogEntry>): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_MODEL_CATALOGS) {
      return;
    }
    if (entry.pending.size === 0) {
      cache.delete(key);
    }
  }
}

function modelCatalogParams(options: ModelsListParams): ModelsListParams {
  const { agentId, view = "configured", ...params } = options;
  return { view, ...params, ...(agentId === undefined ? {} : { agentId: agentId.trim() }) };
}

function modelCatalogKey(params: ModelsListParams): string {
  const { refresh: _refresh, ...projection } = params;
  return JSON.stringify(
    Object.entries(projection)
      .filter(([, value]) => value !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

/** A synchronous display read; the Gateway remains the authority for sending and mutations. */
export function peekModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams,
): ModelCatalogResult | undefined {
  const cache = modelCatalogCache.get(client);
  const key = modelCatalogKey(modelCatalogParams(options));
  const entry = cache?.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    entry.result = undefined;
    entry.expiresAt = undefined;
    if (entry.pending.size === 0) {
      cache?.delete(key);
    }
    return undefined;
  }
  if (cache && entry?.result) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry?.result;
}

/** Cache exact Gateway projections for this connection until its lifecycle invalidates them. */
export async function loadModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams & Pick<GatewayProtocolRequestOptions, "signal" | "timeoutMs">,
): Promise<ModelCatalogResult> {
  const { signal, timeoutMs, ...requestOptions } = options;
  signal?.throwIfAborted();
  const params = modelCatalogParams(requestOptions);
  if (params.refresh) {
    invalidateModelCatalogCache(client);
  } else {
    const result = peekModelCatalog(client, params);
    if (result) {
      return result;
    }
  }
  const cache = modelCatalogCache.get(client) ?? new Map<string, ModelCatalogEntry>();
  modelCatalogCache.set(client, cache);
  const key = modelCatalogKey(params);
  const entry: ModelCatalogEntry = cache.get(key) ?? { scope: params, pending: new Map() };
  const existing = entry.pending.get(timeoutMs);
  if (existing && !existing.controller?.signal.aborted) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }

  const controller = signal ? new AbortController() : undefined;
  const pending: ModelCatalogRequest = {
    refresh: params.refresh === true,
    controller,
    subscribers: new Set(),
    promise: (controller || timeoutMs !== undefined
      ? client.request<ModelCatalogResult>("models.list", params, {
          ...(controller ? { signal: controller.signal } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
      : client.request<ModelCatalogResult>("models.list", params)
    )
      .then((result) => {
        if (
          !controller?.signal.aborted &&
          !result.refreshFailed &&
          modelCatalogCache.get(client) === cache &&
          cache.get(key) === entry &&
          entry.pending.get(timeoutMs) === pending
        ) {
          // Ordinary winners retire competing readers, but cannot retire explicit discovery.
          for (const [budget, request] of entry.pending) {
            if (pending.refresh || !request.refresh) {
              entry.pending.delete(budget);
            }
          }
          // Reads in other views during explicit discovery may still describe its old generation.
          if (params.refresh) {
            cache.clear();
            cache.set(key, entry);
          }
          entry.result = result;
          // Cooldown expiry changes readiness without publishing a new Gateway generation.
          entry.expiresAt = result.models.reduce(
            (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
            Infinity,
          );
          trimModelCatalogCache(cache);
        }
        return result;
      })
      .finally(() => {
        if (
          modelCatalogCache.get(client) === cache &&
          cache.get(key) === entry &&
          entry.pending.get(timeoutMs) === pending
        ) {
          entry.pending.delete(timeoutMs);
          if (!entry.result && entry.pending.size === 0) {
            cache.delete(key);
          }
          trimModelCatalogCache(cache);
        }
      }),
  };
  entry.pending.set(timeoutMs, pending);
  cache.delete(key);
  cache.set(key, entry);
  trimModelCatalogCache(cache);
  return await subscribeToSharedRequest(pending, {}, signal);
}

export function subscribeModelCatalogChanges(
  gateway: ApplicationGateway,
  listener: () => void,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
      listener();
    }
  });
}
