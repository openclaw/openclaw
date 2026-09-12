import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type {
  ModelCatalogTarget,
  ModelsListParams,
  ModelsSnapshotEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "./sessions/session-key.ts";

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

type ModelCatalogCache = {
  entries: Map<string, ModelCatalogEntry>;
  reads: Set<ModelCatalogRead>;
  nextRead: number;
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
  expiresAt?: number;
  publishedRead?: number;
  pending: Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequest>;
};

// Application lifecycle invalidation must not eagerly load catalog readers or presentation.
export const modelCatalogCache = new WeakMap<ModelCatalogClient, ModelCatalogCache>();

export function beginModelCatalogRead(
  client: ModelCatalogClient,
  scope?: ModelsListParams,
  signal?: AbortSignal,
  unresolvedScope = false,
): ModelCatalogRead {
  const cache: ModelCatalogCache = modelCatalogCache.get(client) ?? {
    entries: new Map(),
    reads: new Set(),
    nextRead: 0,
  };
  modelCatalogCache.set(client, cache);
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

export function trimModelCatalogCache(cache: ModelCatalogCache): void {
  for (const [key, entry] of cache.entries) {
    if (cache.entries.size <= MAX_CACHED_MODEL_CATALOGS) {
      return;
    }
    if (entry.pending.size === 0) {
      cache.entries.delete(key);
      // Unresolved reads cannot outlive the publication order of an evicted projection.
      for (const read of cache.reads) {
        if (read.unresolvedScope) {
          cache.reads.delete(read);
        }
      }
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
  read: ModelCatalogRead,
  params: ModelsListParams,
  result: ModelCatalogResult,
): boolean {
  const { cache, client } = read;
  if (
    modelCatalogCache.get(client) !== cache ||
    !cache.reads.has(read) ||
    read.signal?.aborted ||
    result.refreshFailed
  ) {
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
  const entry: ModelCatalogEntry = cache.entries.get(key) ?? { scope: params, pending: new Map() };
  if (!params.refresh && entry.publishedRead !== undefined && entry.publishedRead > read.order) {
    return false;
  }
  // A winner retires same-projection readers, but cannot retire explicit discovery.
  for (const pending of cache.reads) {
    if (
      pending !== read &&
      pending.scope &&
      modelCatalogKey(modelCatalogParams(pending.scope)) === key &&
      (params.refresh || !pending.scope.refresh)
    ) {
      cache.reads.delete(pending);
    }
  }
  for (const [budget, pending] of entry.pending) {
    if (params.refresh || !pending.refresh) {
      entry.pending.delete(budget);
    }
  }
  cache.reads.delete(read);
  if (params.refresh) {
    cache.entries.clear();
    cache.reads.clear();
  }
  entry.result = result;
  entry.publishedRead = read.order;
  // Cooldown expiry changes readiness without publishing a new Gateway generation.
  entry.expiresAt = result.models.reduce(
    (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
    Infinity,
  );
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  trimModelCatalogCache(cache);
  return true;
}

/** Connect reserves a read before any invalidation or replacement can supersede it. */
export function createInitialModelCatalogRead() {
  let target: ModelCatalogTarget | undefined;
  let read: ModelCatalogRead | undefined;
  const targetKey = (value: ModelCatalogTarget) =>
    JSON.stringify(
      "shortId" in value
        ? ["short", value.agentId, value.shortId, value.slugHint]
        : ["scope", value.agentId, value.sessionKey],
    );
  return {
    captureTarget(value: ModelCatalogTarget | undefined) {
      target = value;
      return value;
    },
    start(client: ModelCatalogClient, hello: GatewayHelloOk) {
      invalidateModelCatalogCache(client);
      const scope: ModelCatalogReadScope | undefined =
        target && !("shortId" in target)
          ? target.sessionKey
            ? resolveUiConversationIdentity({ hello }, target.sessionKey, target.agentId)
            : {}
          : undefined;
      read = target
        ? beginModelCatalogRead(client, scope, undefined, scope?.agentId === undefined)
        : undefined;
    },
    receive(event: GatewayEventFrame, host: UiSessionDefaultsHost): GatewayEventFrame | undefined {
      if (event.event !== "models.snapshot") {
        return event;
      }
      const currentRead = read;
      if (!currentRead) {
        return undefined;
      }
      // SAFETY: The negotiated authenticated snapshot carries ModelsSnapshotEvent.
      const publication = event.payload as ModelsSnapshotEvent;
      if (!target || targetKey(target) !== targetKey(publication.target)) {
        return undefined;
      }
      read = undefined;
      const scope = publication.scope.sessionKey
        ? resolveUiConversationIdentity(
            host,
            publication.scope.sessionKey,
            publication.scope.agentId,
          )
        : publication.scope;
      const accepted = publishModelCatalogResult(currentRead, scope, publication.catalog);
      currentRead.cache.reads.delete(currentRead);
      return accepted ? { ...event, payload: { ...publication, scope } } : undefined;
    },
  };
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
  const matches = (readScope: ModelCatalogReadScope | undefined) =>
    !readScope ||
    ((!scope.sessionsOnly || readScope.sessionKey !== undefined) &&
      (scope.agentId === undefined ||
        readScope.agentId === undefined ||
        readScope.agentId === scope.agentId.trim()) &&
      (scope.sessionKey === undefined || readScope.sessionKey === scope.sessionKey) &&
      (scope.authProfileId === undefined || readScope.authProfileId === scope.authProfileId));
  for (const read of cache.reads) {
    if (matches(read.scope)) {
      cache.reads.delete(read);
    }
  }
  for (const [key, entry] of cache.entries) {
    if (matches(entry.scope)) {
      cache.entries.delete(key);
    }
  }
}
