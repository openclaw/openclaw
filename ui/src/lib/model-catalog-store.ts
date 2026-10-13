import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import { sleepWithAbort } from "@openclaw/retry";
import type {
  ModelsListParams,
  ModelsSnapshotEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerModelControlsEnglish } from "../i18n/locales/en-model-controls.ts";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "./gateway-availability.ts";
import {
  invalidateModelCatalogCache,
  invalidateModelCatalogEntry,
  isModelCatalogRetired,
  beginModelCatalogRead,
  getModelCatalogCache,
  modelCatalogCache,
  modelCatalogEventInvalidation,
  modelCatalogKey,
  modelCatalogObservers,
  modelCatalogParams,
  publishModelCatalogResult,
  type ModelCatalogReadScope,
  type ModelCatalogInvalidation,
  type ModelCatalogClient,
  type ModelCatalogCacheUpdate,
  type ModelCatalogRequest,
} from "./model-catalog-cache.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

registerModelControlsEnglish();

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  initialized?: boolean;
  retired?: boolean;
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  refreshFailed?: boolean;
  pendingProviders?: readonly string[];
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

export type ModelCatalogPresentation = ModelCatalogResult & {
  hasSnapshot: boolean;
  retired: boolean;
};

/** Settings readers share the catalog's accepted display receipt and retirement boundary. */
export function readModelCatalog(
  client: ModelCatalogClient | null | undefined,
  scope: ModelCatalogReadScope | null | undefined,
): ModelCatalogPresentation {
  const catalog =
    client && scope ? peekModelCatalog(client, scope, { allowStale: true }) : undefined;
  return {
    ...catalog,
    models: catalog?.models ?? [],
    hasSnapshot: catalog !== undefined,
    retired: client && scope ? isModelCatalogRetired(client, scope) : false,
  };
}

export function readAgentModelCatalog(
  client: ModelCatalogClient | null | undefined,
  agentId: string | null | undefined,
): ModelCatalogPresentation {
  return readModelCatalog(client, agentId ? { agentId } : null);
}

export function subscribeModelCatalogCache(
  client: ModelCatalogClient,
  listener: (update: ModelCatalogCacheUpdate) => void,
): () => void {
  const listeners = modelCatalogObservers.get(client) ?? new Set();
  modelCatalogObservers.set(client, listeners);
  listeners.add(listener);
  return () => {
    if (listeners.delete(listener) && listeners.size === 0) {
      modelCatalogObservers.delete(client);
    }
  };
}

export function resolveModelCatalogState(
  result: Pick<ModelCatalogResult, "models" | "refreshFailed" | "modelSelectionPolicy"> &
    Pick<ChatModelCatalogState, "pendingProviders">,
  {
    connected = true,
    loading = false,
    error = null,
    retired = false,
    initialized = true,
  }: {
    connected?: boolean;
    loading?: boolean;
    error?: string | null;
    retired?: boolean;
    initialized?: boolean;
  } = {},
): ChatModelCatalogState {
  return {
    hasSnapshot: initialized && !retired && (result.models.length > 0 || (!loading && !error)),
    initialized,
    retired,
    modelSelectionPolicy: result.modelSelectionPolicy,
    refreshFailed: result.refreshFailed,
    pendingProviders: result.pendingProviders,
    status: !connected
      ? "offline"
      : error
        ? "error"
        : loading
          ? "loading"
          : initialized
            ? "ready"
            : "idle",
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
  { allowStale = false }: { allowStale?: boolean } = {},
): ModelCatalogResult | undefined {
  const cache = modelCatalogCache.get(client)?.entries;
  const key = modelCatalogKey(modelCatalogParams(options));
  const entry = cache?.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    invalidateModelCatalogEntry(client, entry);
  }
  if (entry?.invalidated && !allowStale) {
    return undefined;
  }
  if (cache && entry?.result) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry?.result;
}

export function settleModelCatalogRequests(
  client: ModelCatalogClient,
  scope: ModelsListParams,
): Promise<void> | undefined {
  const key = modelCatalogKey(modelCatalogParams(scope));
  const pending = Array.from(modelCatalogCache.get(client)?.requests.get(key)?.values() ?? []).map(
    (request) => request.transportSettled,
  );
  return pending.length ? Promise.allSettled(pending).then(() => {}) : undefined;
}

/** Cache exact Gateway projections; concurrent readers share one request per budget. */
export async function loadModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams & Pick<GatewayProtocolRequestOptions, "signal" | "timeoutMs">,
): Promise<ModelCatalogResult> {
  const { signal, timeoutMs, ...requestOptions } = options;
  signal?.throwIfAborted();
  const params = modelCatalogParams(requestOptions);
  if (!params.refresh) {
    const result = peekModelCatalog(client, params);
    if (result) {
      return result;
    }
  }
  const cache = getModelCatalogCache(client);
  const key = modelCatalogKey(params);
  const budgets =
    cache.requests.get(key) ??
    new Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequest>();
  cache.requests.set(key, budgets);
  const existing = budgets.get(timeoutMs);
  if (existing && !existing.controller.signal.aborted && (!params.refresh || existing.refresh)) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }
  if (params.refresh) {
    invalidateModelCatalogCache(client);
  }
  const controller = new AbortController();
  const completion = createDeferredCore<ModelCatalogResult>();
  const settled = createDeferredCore();
  const pending: ModelCatalogRequest = {
    refresh: params.refresh === true,
    controller,
    promise: completion.promise,
    transportSettled: settled.promise,
    resolve: completion.resolve,
    reject: completion.reject,
    subscribers: new Set(),
  };
  budgets.set(timeoutMs, pending);
  const subscription = subscribeToSharedRequest(pending, {}, signal);
  const read = beginModelCatalogRead(client, params, controller.signal);
  // A catalog change during this request may display the older list until its next refresh.
  const request = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await (timeoutMs === undefined
          ? client.request<ModelCatalogResult>("models.list", params)
          : client.request<ModelCatalogResult>("models.list", params, {
              timeoutMs,
              signal: controller.signal,
            }));
      } catch (error) {
        if (!isAgentDatabaseInspectionPendingError(error)) {
          throw error;
        }
        // Agent preparation can take minutes after an ordinary Gateway restart.
        await sleepWithAbort(resolveGatewayReadRetryDelayMs(error, attempt), controller.signal);
      }
    }
  };
  void request()
    .then((result) => {
      publishModelCatalogResult(read, params, result);
      pending.resolve(result);
    }, pending.reject)
    .catch(pending.reject)
    .finally(() => {
      settled.resolve();
      if (budgets.get(timeoutMs) === pending) {
        budgets.delete(timeoutMs);
        if (budgets.size === 0) {
          cache.requests.delete(key);
        }
      }
    });
  return await subscription;
}

export function subscribeModelCatalogChanges(
  gateway: ApplicationGateway,
  listener: (invalidation: ModelCatalogInvalidation) => void,
  scope?: ModelCatalogReadScope,
): () => void {
  return gateway.subscribeEvents((event) => {
    const invalidation = modelCatalogEventInvalidation(event);
    if (invalidation) {
      listener(invalidation);
    } else if (event.event === "models.snapshot" && scope) {
      // SAFETY: The authenticated connect dispatcher emits this as ModelsSnapshotEvent.
      const publication = event.payload as ModelsSnapshotEvent;
      if (
        modelCatalogKey(modelCatalogParams(scope)) ===
        modelCatalogKey(modelCatalogParams(publication.scope))
      ) {
        listener("refresh");
      }
    }
  });
}
