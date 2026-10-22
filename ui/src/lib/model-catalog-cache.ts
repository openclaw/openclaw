import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import {
  hasUiSessionDefaults,
  parseAgentSessionKey,
  uiConversationMatches,
  type UiSessionDefaultsHost,
} from "./sessions/session-key.ts";

export type ModelCatalogReadScope = Pick<
  ModelsListParams,
  "agentId" | "sessionKey" | "authProfileId"
>;
type ModelCatalogInvalidationScope = ModelCatalogReadScope & {
  sessionsOnly?: boolean;
  pendingOnly?: boolean;
  sessionModelRevision?: string;
};
export type ModelCatalogCacheUpdate = {
  type: "published" | "invalidated";
  matches: (scope: ModelsListParams, key: string) => boolean;
};

export type ModelCatalogClient = Pick<GatewayBrowserClient, "request">;
export type ModelCatalogInvalidation = "clear" | "refresh" | "pending";

export function modelCatalogEventInvalidation(
  event: Pick<GatewayEventFrame, "event" | "payload">,
  scope?: ModelCatalogReadScope,
): ModelCatalogInvalidation | undefined {
  if (event.event === "config.changed") {
    return "refresh";
  }
  if (event.event === "chat.metadata.changed") {
    const payload = asNullableRecord(event.payload);
    if (payload?.modelSelectionChanged === true) {
      return "clear";
    }
    if (
      scope?.agentId !== undefined &&
      typeof payload?.agentId === "string" &&
      scope.agentId.trim() !== payload.agentId.trim()
    ) {
      return undefined;
    }
    return payload?.modelCatalogChanged === false
      ? payload.modelCatalogStatusChanged === true
        ? "pending"
        : undefined
      : "refresh";
  }
  return undefined;
}

export type ModelCatalogRequest = {
  refresh: boolean;
  controller: AbortController;
  promise: Promise<ModelCatalogResult>;
  resolve: (result: ModelCatalogResult) => void;
  reject: (error: unknown) => void;
  subscribers: Set<object>;
};

type ModelCatalogCache = {
  entries: Map<string, ModelCatalogEntry>;
  snapshot?: ModelCatalogRead & { promise: Promise<void>; release: () => void };
  requiresSnapshot?: boolean;
  requests: Map<string, Map<string, ModelCatalogRequest>>;
};

export type ModelCatalogRead = {
  client: ModelCatalogClient;
  cache: ModelCatalogCache;
  scope?: ModelsListParams;
  signal?: AbortSignal;
};
export type ModelCatalogEntry = {
  scope: ModelCatalogReadScope;
  result?: ModelCatalogResult;
  invalidated?: boolean;
  expiresAt?: number;
};

// Application lifecycle invalidation must not eagerly load catalog readers or presentation.
export const modelCatalogCache = new WeakMap<ModelCatalogClient, ModelCatalogCache>();
export const modelCatalogObservers = new WeakMap<
  ModelCatalogClient,
  Set<(update: ModelCatalogCacheUpdate) => void>
>();

export function getModelCatalogCache(client: ModelCatalogClient): ModelCatalogCache {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = { entries: new Map(), requests: new Map() };
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

function notifyModelCatalogCache(
  client: ModelCatalogClient,
  update: ModelCatalogCacheUpdate,
): void {
  const cache = modelCatalogCache.get(client);
  if (cache && update.type === "invalidated") {
    const snapshot = cache.snapshot;
    if (
      snapshot &&
      (!snapshot.scope || update.matches(snapshot.scope, modelCatalogKey(snapshot.scope)))
    ) {
      snapshot.release();
    }
  }
  for (const listener of Array.from(modelCatalogObservers.get(client) ?? [])) {
    listener(update);
  }
}

export function beginModelCatalogRead(
  client: ModelCatalogClient,
  scope?: ModelsListParams,
  signal?: AbortSignal,
): ModelCatalogRead {
  return { client, cache: getModelCatalogCache(client), scope, signal };
}

/** Bootstrap owns one read before connected views can request the same projection. */
export function beginModelCatalogSnapshot(
  client: ModelCatalogClient,
  scope?: ModelsListParams,
): ModelCatalogRead {
  const controller = new AbortController();
  const read = beginModelCatalogRead(client, scope && modelCatalogParams(scope), controller.signal);
  const { promise, resolve } = Promise.withResolvers<void>();
  const release = () => {
    clearTimeout(timer);
    controller.abort();
    if (read.cache.snapshot === snapshot) {
      read.cache.snapshot = undefined;
    }
    resolve();
  };
  // Failed bootstrap replies are unsolicited responses. A missing snapshot must
  // fall back to the ordinary read, without waiting its full RPC timeout.
  const timer = setTimeout(resolve, 1_000);
  const snapshot = { ...read, promise, release };
  read.cache.snapshot?.release();
  read.cache.snapshot = snapshot;
  return read;
}

const MAX_CACHED_MODEL_CATALOGS = 64;

function trimModelCatalogCache(client: ModelCatalogClient, cache: ModelCatalogCache): void {
  const retired = new Set<string>();
  for (const key of cache.entries.keys()) {
    if (cache.entries.size <= MAX_CACHED_MODEL_CATALOGS) {
      break;
    }
    cache.entries.delete(key);
    retired.add(key);
  }
  if (retired.size && modelCatalogCache.get(client) === cache) {
    notifyModelCatalogCache(client, {
      type: "invalidated",
      matches: (_scope, key) => retired.has(key),
    });
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
  read: ModelCatalogRead,
  params: ModelsListParams,
  result: ModelCatalogResult,
): boolean {
  const { cache, client } = read;
  if (modelCatalogCache.get(client) !== cache || read.signal?.aborted) {
    return false;
  }
  const key = modelCatalogKey(modelCatalogParams(params));
  if (read.scope) {
    const expected = modelCatalogParams(read.scope);
    if (expected.agentId === undefined) {
      expected.agentId = params.agentId;
    }
    if (modelCatalogKey(expected) !== key) {
      return false;
    }
  }
  const snapshot = cache.snapshot;
  // A completed fallback owns this projection, but an unsettled read can still use bootstrap.
  if (snapshot && snapshot.signal === read.signal && cache.entries.has(key)) {
    snapshot.release();
    return false;
  }
  const entry: ModelCatalogEntry = cache.entries.get(key) ?? { scope: params };
  const discoverySucceeded = !result.refreshFailed;
  if (params.refresh && discoverySucceeded) {
    for (const other of cache.entries.values()) {
      if (other !== entry) {
        markModelCatalogInvalid(other);
      }
    }
  }
  entry.result = result;
  entry.invalidated = !discoverySucceeded;
  // Cooldown expiry changes readiness without publishing a new Gateway generation.
  entry.expiresAt = discoverySucceeded
    ? result.models.reduce(
        (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
        Infinity,
      )
    : undefined;
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  const requiredSnapshot = cache.requiresSnapshot;
  cache.requiresSnapshot = result.modelSelectionPolicy?.restricted === true;
  const admissionChanged = requiredSnapshot !== cache.requiresSnapshot;
  if (snapshot && snapshot.signal === read.signal) {
    snapshot.release();
  }
  for (const pending of cache.requests.get(key)?.values() ?? []) {
    if (discoverySucceeded && (params.refresh || !pending.refresh)) {
      pending.resolve(result);
    }
  }
  trimModelCatalogCache(client, cache);
  if (params.refresh && discoverySucceeded) {
    notifyModelCatalogCache(client, {
      type: "invalidated",
      matches: (_scope, candidateKey) => candidateKey !== key,
    });
  }
  notifyModelCatalogCache(client, {
    type: "published",
    // Global admission changes matter to cold scopes. Held projections keep their
    // own receipt; successful refresh/eviction invalidations are published above.
    matches: (_scope, candidateKey) =>
      candidateKey === key || (admissionChanged && !cache.entries.get(candidateKey)?.result),
  });
  return true;
}

function markModelCatalogInvalid(entry: ModelCatalogEntry): void {
  entry.invalidated = true;
  entry.expiresAt = undefined;
}

export function invalidateModelCatalogEntry(
  client: ModelCatalogClient,
  entry: ModelCatalogEntry,
): void {
  markModelCatalogInvalid(entry);
  const key = modelCatalogKey(modelCatalogParams(entry.scope));
  notifyModelCatalogCache(client, {
    type: "invalidated",
    matches: (_scope, candidateKey) => candidateKey === key,
  });
}

/** A connection boundary retires even the last accepted display snapshot. */
export function clearModelCatalogCache(
  client: ModelCatalogClient,
  options?: { requireSnapshot?: boolean },
): void {
  const cache = modelCatalogCache.get(client);
  cache?.snapshot?.release();
  modelCatalogCache.delete(client);
  getModelCatalogCache(client).requiresSnapshot =
    options?.requireSnapshot === true ||
    cache?.requiresSnapshot === true ||
    (cache?.entries.size ?? 0) > 0;
  for (const budgets of cache?.requests.values() ?? []) {
    for (const pending of budgets.values()) {
      const error = new DOMException("Model catalog connection retired", "AbortError");
      pending.controller.abort(error);
      pending.reject(error);
    }
  }
  notifyModelCatalogCache(client, { type: "invalidated", matches: () => true });
}

/** Configuration and identity changes retire display facts until this scope is published again. */
export function isModelCatalogRetired(
  client: ModelCatalogClient,
  scope: ModelsListParams,
): boolean {
  const cache = modelCatalogCache.get(client);
  return (
    cache?.requiresSnapshot === true &&
    !cache.entries.get(modelCatalogKey(modelCatalogParams(scope)))?.result
  );
}

/** An accepted unrestricted receipt also covers another cold view on this connection. */
export function hasUnrestrictedModelCatalogSnapshot(
  client: ModelCatalogClient | null | undefined,
): boolean {
  const cache = client && modelCatalogCache.get(client);
  return Boolean(cache?.entries.size && cache.requiresSnapshot === false);
}

/** Retire read eligibility while preserving the last accepted, scoped display snapshot. */
export function invalidateModelCatalogCache(
  client: ModelCatalogClient,
  scope?: ModelCatalogInvalidationScope,
  sessionDefaults?: UiSessionDefaultsHost,
): (scope: ModelsListParams | undefined) => boolean {
  const cache = modelCatalogCache.get(client);
  if (!cache) {
    return () => true;
  }
  const unchanged = new Set(
    scope?.sessionModelRevision || scope?.pendingOnly
      ? Array.from(cache.entries)
          .filter(([, entry]) =>
            scope.pendingOnly
              ? entry.result !== undefined && !entry.result.pendingProviders?.length
              : entry.result?.sessionModelRevision === scope.sessionModelRevision,
          )
          .map(([key]) => key)
      : [],
  );
  const matches = (readScope: ModelsListParams | undefined) => {
    if (readScope && unchanged.has(modelCatalogKey(modelCatalogParams(readScope)))) {
      return false;
    }
    if (!scope || !readScope) {
      return true;
    }
    if (
      (scope.sessionsOnly && readScope.sessionKey === undefined) ||
      (scope.agentId !== undefined &&
        readScope.agentId !== undefined &&
        readScope.agentId !== scope.agentId.trim()) ||
      (scope.authProfileId !== undefined && readScope.authProfileId !== scope.authProfileId)
    ) {
      return false;
    }
    if (scope.sessionKey === undefined) {
      return true;
    }
    if (!sessionDefaults) {
      return readScope.sessionKey === scope.sessionKey;
    }
    // Before routing facts arrive, a bare saved alias cannot be ruled out.
    if (
      readScope.sessionKey !== undefined &&
      !hasUiSessionDefaults(sessionDefaults) &&
      !parseAgentSessionKey(readScope.sessionKey)
    ) {
      return true;
    }
    return uiConversationMatches(
      sessionDefaults,
      readScope.sessionKey,
      scope.sessionKey,
      scope.agentId,
      readScope.agentId,
    );
  };
  for (const entry of cache.entries.values()) {
    if (matches(entry.scope)) {
      markModelCatalogInvalid(entry);
    }
  }
  notifyModelCatalogCache(client, {
    type: "invalidated",
    matches,
  });
  return matches;
}
