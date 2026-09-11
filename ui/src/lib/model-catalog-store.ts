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
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

export function resolveModelCatalogState(
  result: Pick<ModelCatalogResult, "models" | "refreshFailed">,
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

function modelCatalogParams(options: ModelsListParams): ModelsListParams {
  const { agentId, view = "configured", ...params } = options;
  return { view, ...params, ...(agentId === undefined ? {} : { agentId: agentId.trim() }) };
}

function modelCatalogKey(params: ModelsListParams): string {
  const { refresh: _refresh, ...projection } = params;
  return JSON.stringify(
    Object.entries(projection)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
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
  if (cache && entry?.result) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry?.result;
}

/** Cache exact Gateway projections for this connection until its lifecycle invalidates them. */
export async function loadModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams & { signal?: AbortSignal },
): Promise<ModelCatalogResult> {
  const { signal, ...requestOptions } = options;
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
  const existing = cache.get(key)?.pending;
  if (existing && !existing.controller?.signal.aborted) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }

  const controller = signal ? new AbortController() : undefined;
  const entry: ModelCatalogEntry = { scope: params };
  const pending: ModelCatalogRequest = {
    controller,
    subscribers: new Set(),
    promise: (controller
      ? client.request<ModelCatalogResult>("models.list", params, { signal: controller.signal })
      : client.request<ModelCatalogResult>("models.list", params)
    )
      .then((result) => {
        if (
          !controller?.signal.aborted &&
          !result.refreshFailed &&
          modelCatalogCache.get(client) === cache &&
          cache.get(key) === entry
        ) {
          // Reads in other views during explicit discovery may still describe its old generation.
          if (params.refresh) {
            cache.clear();
            cache.set(key, entry);
          }
          entry.result = result;
        }
        return result;
      })
      .finally(() => {
        if (cache.get(key) === entry) {
          entry.pending = undefined;
          if (!entry.result) {
            cache.delete(key);
          }
        }
      }),
  };
  entry.pending = pending;
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_MODEL_CATALOGS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
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
