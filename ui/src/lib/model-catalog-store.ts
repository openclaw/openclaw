import {
  GatewayProtocolRequestTimeoutError,
  isGatewayProtocolResponseError,
  resolveSafeTimeoutDelayMs,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
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
  type ModelCatalogRead,
  type ModelCatalogRequest,
  type ModelCatalogRequestLane,
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
export function readAgentModelCatalog(
  client: ModelCatalogClient | null | undefined,
  agentId: string | null | undefined,
): ModelCatalogPresentation {
  if (!client || !agentId) {
    return { models: [], hasSnapshot: false, retired: false };
  }
  const scope = { agentId };
  const catalog = peekModelCatalog(client, scope, { allowStale: true });
  return {
    ...catalog,
    models: catalog?.models ?? [],
    hasSnapshot: catalog !== undefined,
    retired: isModelCatalogRetired(client, scope),
  };
}

export function subscribeModelCatalogCache(
  client: ModelCatalogClient,
  listener: (update: ModelCatalogCacheUpdate) => void,
): () => void {
  const listeners = modelCatalogObservers.get(client) ?? new Set();
  modelCatalogObservers.set(client, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
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
    // Keep ordering until bounded eviction so an older unresolved read cannot refill this slot.
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
  const pending = Array.from(modelCatalogCache.get(client)?.requests.get(key)?.values() ?? [])
    .map((lane) => lane.active?.transportSettled)
    .filter((promise) => promise !== undefined);
  return pending.length ? Promise.allSettled(pending).then(() => {}) : undefined;
}

function createModelCatalogRequest(params: {
  client: ModelCatalogClient;
  scope: ModelsListParams;
  timeoutMs: GatewayProtocolRequestOptions["timeoutMs"];
  cache: ModelCatalogRead["cache"];
  lane: ModelCatalogRequestLane;
  queued: boolean;
  releaseLane: () => void;
}): ModelCatalogRequest {
  const { client, cache, lane, timeoutMs } = params;
  const controller = new AbortController();
  const completion = createDeferredCore<ModelCatalogResult>();
  const transportSettled = createDeferredCore();
  const duration =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? resolveSafeTimeoutDelayMs(timeoutMs, { minMs: 0 })
      : undefined;
  const deadline = duration === undefined ? undefined : Date.now() + duration;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let requestSent = false;
  const canRetry = () =>
    !pending.settled &&
    !controller.signal.aborted &&
    pending.subscribers.size > 0 &&
    modelCatalogCache.get(client) === cache &&
    cache.reads.has(pending.read) &&
    lane.active === pending &&
    !lane.queued;
  const retireCompletion = () => {
    clearTimeout(deadlineTimer);
    cache.reads.delete(pending.read);
    pending.settled = true;
    if (lane.queued === pending) {
      lane.queued = undefined;
      params.releaseLane();
    }
  };
  const finishTransport = () => {
    transportSettled.resolve();
    if (lane.active !== pending) {
      return;
    }
    lane.active = undefined;
    const next = lane.queued;
    if (next && modelCatalogCache.get(client) === cache) {
      lane.queued = undefined;
      lane.active = next;
      next.start();
    }
    params.releaseLane();
  };
  const pending: ModelCatalogRequest = {
    refresh: params.scope.refresh === true,
    controller,
    read: beginModelCatalogRead(client, params.scope, controller.signal),
    preparing: true,
    settled: false,
    subscribers: new Set(),
    promise: completion.promise,
    transportSettled: transportSettled.promise,
    resolve: (result) => {
      if (!pending.settled) {
        retireCompletion();
        completion.resolve(result);
      }
    },
    reject: (error) => {
      if (!pending.settled) {
        retireCompletion();
        completion.reject(error);
      }
    },
    start: () => {
      if (started) {
        return;
      }
      started = true;
      if (pending.settled) {
        finishTransport();
        return;
      }
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (params.queued && duration !== undefined && remaining !== undefined && remaining <= 0) {
        pending.reject(
          new GatewayProtocolRequestTimeoutError({
            method: "models.list",
            timeoutMs: duration,
            requestSent: false,
          }),
        );
        finishTransport();
        return;
      }
      const read = pending.read;
      const requestParams = { ...params.scope, ...(pending.refresh ? { refresh: true } : {}) };
      void (async () => {
        let retried = false;
        for (;;) {
          try {
            // Only a received rejection can retry; local timeout still owns its transport.
            // The existing numeric deadline covers every attempt and wait in this lane.
            const result = await (timeoutMs === undefined
              ? client.request<ModelCatalogResult>("models.list", requestParams)
              : client.request<ModelCatalogResult>("models.list", requestParams, {
                  timeoutMs: duration === undefined ? timeoutMs : null,
                  ...(duration === undefined
                    ? {}
                    : {
                        onSent: () => {
                          requestSent = true;
                        },
                      }),
                }));
            publishModelCatalogResult(read, requestParams, result);
            pending.resolve(result);
            return;
          } catch (error) {
            if (
              retried ||
              !isGatewayProtocolResponseError(error) ||
              error.gatewayCode !== "UNAVAILABLE" ||
              !error.retryable ||
              !canRetry()
            ) {
              pending.reject(error);
              return;
            }
            // Retry one superseded snapshot without chasing an indefinitely busy Gateway.
            retried = true;
            const wake = createDeferredCore();
            const timer = setTimeout(
              wake.resolve,
              resolveSafeTimeoutDelayMs(error.retryAfterMs ?? 0, { minMs: 0 }),
            );
            const stopWatching = subscribeModelCatalogCache(client, () => {
              if (!canRetry()) {
                wake.resolve();
              }
            });
            void completion.promise.then(
              () => wake.resolve(),
              () => wake.resolve(),
            );
            try {
              await wake.promise;
            } finally {
              clearTimeout(timer);
              stopWatching();
            }
            if (deadline !== undefined && duration !== undefined && deadline <= Date.now()) {
              pending.reject(
                new GatewayProtocolRequestTimeoutError({
                  method: "models.list",
                  timeoutMs: duration,
                  requestSent,
                }),
              );
              return;
            }
            if (!canRetry()) {
              pending.reject(error);
              return;
            }
          }
        }
      })()
        .catch(pending.reject)
        .finally(finishTransport);
    },
  };
  controller.signal.addEventListener("abort", () => pending.reject(controller.signal.reason), {
    once: true,
  });
  if (duration !== undefined) {
    deadlineTimer = setTimeout(
      () =>
        pending.reject(
          new GatewayProtocolRequestTimeoutError({
            method: "models.list",
            timeoutMs: duration,
            requestSent,
          }),
        ),
      duration,
    );
  }
  return pending;
}

/** Cache exact Gateway projections for this connection until its lifecycle invalidates them. */
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
  const owner = getModelCatalogCache(client);
  const key = modelCatalogKey(params);
  const budgets =
    owner.requests.get(key) ??
    new Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequestLane>();
  owner.requests.set(key, budgets);
  const lane: ModelCatalogRequestLane = budgets.get(timeoutMs) ?? {};
  budgets.set(timeoutMs, lane);
  const releaseLane = () => {
    if (!lane.active && !lane.queued) {
      budgets.delete(timeoutMs);
      if (budgets.size === 0) {
        owner.requests.delete(key);
      }
    }
  };
  const existing = lane.queued ?? lane.active;
  if (
    existing &&
    !existing.settled &&
    !existing.controller.signal.aborted &&
    (existing.preparing || (!params.refresh && owner.reads.has(existing.read)))
  ) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }
  const adopting = lane.queued !== undefined;
  const pending =
    lane.queued ??
    createModelCatalogRequest({
      client,
      scope: params,
      timeoutMs,
      cache: owner,
      lane,
      queued: lane.active !== undefined,
      releaseLane,
    });
  if (lane.active) {
    lane.queued = pending;
  } else {
    lane.active = pending;
  }
  pending.preparing = true;
  pending.refresh ||= params.refresh === true;
  const subscription = subscribeToSharedRequest(pending, {}, signal);
  if (params.refresh) {
    invalidateModelCatalogCache(client);
  }
  if (modelCatalogCache.get(client) !== owner) {
    pending.reject(new DOMException("Model catalog connection retired", "AbortError"));
  } else if (adopting || params.refresh) {
    owner.reads.delete(pending.read);
    pending.read = beginModelCatalogRead(
      client,
      { ...params, ...(pending.refresh ? { refresh: true } : {}) },
      pending.controller.signal,
    );
  }
  pending.preparing = false;
  if (lane.active === pending) {
    pending.start();
  }
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
