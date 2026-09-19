import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
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
type ModelCatalogInvalidationScope = ModelCatalogReadScope & { sessionsOnly?: boolean };
export type ModelCatalogCacheUpdate =
  | { type: "published" }
  | { type: "invalidated"; matches: (scope: ModelsListParams, key: string) => boolean };

export type ModelCatalogClient = Pick<GatewayBrowserClient, "request">;
export type ModelCatalogRequest = {
  refresh: boolean;
  controller: AbortController;
  read: ModelCatalogRead;
  preparing: boolean;
  settled: boolean;
  promise: Promise<ModelCatalogResult>;
  transportSettled: Promise<void>;
  resolve: (result: ModelCatalogResult) => void;
  reject: (error: unknown) => void;
  start: () => void;
  subscribers: Set<object>;
};

export type ModelCatalogRequestLane = {
  active?: ModelCatalogRequest;
  queued?: ModelCatalogRequest;
};

type ModelCatalogCache = {
  entries: Map<string, ModelCatalogEntry>;
  reads: Set<ModelCatalogRead>;
  nextRead: number;
  requests: Map<string, Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequestLane>>;
};

export type ModelCatalogRead = {
  client: ModelCatalogClient;
  cache: ModelCatalogCache;
  scope?: ModelsListParams;
  signal?: AbortSignal;
  order: number;
  unresolvedScope: boolean;
};
export type ModelCatalogEntry = {
  scope: ModelCatalogReadScope;
  result?: ModelCatalogResult;
  invalidated?: boolean;
  expiresAt?: number;
  publishedRead?: number;
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
    cache = { entries: new Map(), reads: new Set(), nextRead: 0, requests: new Map() };
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

function notifyModelCatalogCache(
  client: ModelCatalogClient,
  update: ModelCatalogCacheUpdate,
): void {
  for (const listener of Array.from(modelCatalogObservers.get(client) ?? [])) {
    listener(update);
  }
}

export function beginModelCatalogRead(
  client: ModelCatalogClient,
  scope?: ModelsListParams,
  signal?: AbortSignal,
  unresolvedScope = false,
): ModelCatalogRead {
  const cache = getModelCatalogCache(client);
  const read: ModelCatalogRead = {
    client,
    cache,
    scope,
    signal,
    unresolvedScope,
    order: ++cache.nextRead,
  };
  cache.reads.add(read);
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
    // Display eviction retires publication, never an unsettled transport's ownership.
    for (const read of cache.reads) {
      if (
        read.unresolvedScope ||
        (read.scope && modelCatalogKey(modelCatalogParams(read.scope)) === key)
      ) {
        cache.reads.delete(read);
      }
    }
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
  if (modelCatalogCache.get(client) !== cache || !cache.reads.has(read) || read.signal?.aborted) {
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
  const entry: ModelCatalogEntry = cache.entries.get(key) ?? { scope: params };
  if (!params.refresh && (entry.publishedRead ?? 0) > read.order) {
    return false;
  }
  const discoverySucceeded = !result.refreshFailed;
  // Partial inventory updates display without settling another reader's discovery.
  for (const pending of cache.reads) {
    if (
      discoverySucceeded &&
      pending !== read &&
      pending.scope &&
      modelCatalogKey(modelCatalogParams(pending.scope)) === key &&
      (params.refresh || !pending.scope.refresh)
    ) {
      cache.reads.delete(pending);
    }
  }
  cache.reads.delete(read);
  if (params.refresh && discoverySucceeded) {
    for (const other of cache.entries.values()) {
      if (other !== entry) {
        markModelCatalogInvalid(other);
      }
    }
    cache.reads.clear();
  }
  entry.result = result;
  entry.invalidated = !discoverySucceeded;
  entry.publishedRead = read.order;
  // Cooldown expiry changes readiness without publishing a new Gateway generation.
  entry.expiresAt = discoverySucceeded
    ? result.models.reduce(
        (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
        Infinity,
      )
    : undefined;
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  for (const lane of cache.requests.get(key)?.values() ?? []) {
    for (const pending of [lane.active, lane.queued]) {
      if (pending && discoverySucceeded && (params.refresh || !pending.refresh)) {
        pending.resolve(result);
      }
    }
  }
  trimModelCatalogCache(client, cache);
  if (params.refresh && discoverySucceeded) {
    notifyModelCatalogCache(client, {
      type: "invalidated",
      matches: (_scope, candidateKey) => candidateKey !== key,
    });
  }
  notifyModelCatalogCache(client, { type: "published" });
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
export function clearModelCatalogCache(client: ModelCatalogClient): void {
  const cache = modelCatalogCache.get(client);
  modelCatalogCache.delete(client);
  for (const budgets of cache?.requests.values() ?? []) {
    for (const lane of budgets.values()) {
      lane.queued?.reject(new DOMException("Model catalog connection retired", "AbortError"));
    }
  }
  notifyModelCatalogCache(client, { type: "invalidated", matches: () => true });
}

/** Retire read eligibility while preserving the last accepted, scoped display snapshot. */
export function invalidateModelCatalogCache(
  client: ModelCatalogClient,
  scope?: ModelCatalogInvalidationScope,
  sessionDefaults?: UiSessionDefaultsHost,
  retainedKeys?: ReadonlySet<string>,
): void {
  const cache = modelCatalogCache.get(client);
  if (!cache) {
    return;
  }
  const matches = (readScope: ModelCatalogReadScope | undefined) => {
    if (readScope && retainedKeys?.has(modelCatalogKey(modelCatalogParams(readScope)))) {
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
  for (const read of cache.reads) {
    if (matches(read.scope)) {
      cache.reads.delete(read);
    }
  }
  for (const entry of cache.entries.values()) {
    if (matches(entry.scope)) {
      markModelCatalogInvalid(entry);
    }
  }
  notifyModelCatalogCache(client, {
    type: "invalidated",
    matches,
  });
}
