import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type {
  ModelsListParams,
  ModelsSnapshotEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import {
  invalidateModelCatalogCache,
  beginModelCatalogRead,
  modelCatalogCache,
  modelCatalogKey,
  modelCatalogParams,
  publishModelCatalogResult,
  trimModelCatalogCache,
  type ModelCatalogReadScope,
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

/** A synchronous display read; the Gateway remains the authority for sending and mutations. */
export function peekModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams,
): ModelCatalogResult | undefined {
  const cache = modelCatalogCache.get(client)?.entries;
  const key = modelCatalogKey(modelCatalogParams(options));
  const entry = cache?.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    entry.result = undefined;
    entry.expiresAt = undefined;
    // Keep ordering until bounded eviction so an older unresolved read cannot refill this slot.
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
  const owner = modelCatalogCache.get(client);
  const key = modelCatalogKey(params);
  const entry: ModelCatalogEntry = owner?.entries.get(key) ?? { scope: params, pending: new Map() };
  const existing = entry.pending.get(timeoutMs);
  if (existing && !existing.controller?.signal.aborted) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }

  const controller = signal ? new AbortController() : undefined;
  const read = beginModelCatalogRead(client, params, controller?.signal);
  const cache = read.cache.entries;
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
        publishModelCatalogResult(read, params, result);
        return result;
      })
      .finally(() => {
        read.cache.reads.delete(read);
        if (
          modelCatalogCache.get(client) === read.cache &&
          cache.get(key) === entry &&
          entry.pending.get(timeoutMs) === pending
        ) {
          entry.pending.delete(timeoutMs);
          if (!entry.result && entry.publishedRead === undefined && entry.pending.size === 0) {
            cache.delete(key);
          }
          trimModelCatalogCache(read.cache);
        }
      }),
  };
  entry.pending.set(timeoutMs, pending);
  cache.delete(key);
  cache.set(key, entry);
  trimModelCatalogCache(read.cache);
  return await subscribeToSharedRequest(pending, {}, signal);
}

export function subscribeModelCatalogChanges(
  gateway: ApplicationGateway,
  listener: () => void,
  scope?: ModelCatalogReadScope,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
      listener();
    } else if (event.event === "models.snapshot" && scope) {
      // SAFETY: The authenticated connect dispatcher emits this as ModelsSnapshotEvent.
      const publication = event.payload as ModelsSnapshotEvent;
      if (
        modelCatalogKey(modelCatalogParams(scope)) ===
        modelCatalogKey(modelCatalogParams(publication.scope))
      ) {
        listener();
      }
    }
  });
}
