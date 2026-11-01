import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { DiagnosticWorkerRetainedData } from "../infra/diagnostic-process-types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { estimateRetainedDataSize } from "../infra/retained-data-size.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import {
  consumeLiveCatalogRefresh,
  getProviderCatalogDiscoveryBudget,
  recordLiveCatalogExpiry,
} from "./provider-catalog-expiry.js";

type LiveCatalogCacheEntry<T> = {
  expiresAt: number;
  result: { state: "pending"; value: Promise<T> } | { state: "fulfilled"; value: T };
  retained: boolean;
  now?: () => number;
};

type LiveCatalogCache = {
  entries: Map<string, LiveCatalogCacheEntry<unknown>>;
  expiry?: { at: number; cancel: () => void };
};

const LIVE_CATALOG_CACHE_MAX_ENTRIES = 100;
// Preserve the TTL cache across restarts and registry replacement, but release
// its payloads when the final runtime closes.
const cache = resolveGlobalSingleton<LiveCatalogCache>(
  Symbol.for("openclaw.providerLiveCatalogCache"),
  () => ({ entries: new Map() }),
  clearLiveCatalogCache,
  "close-only",
);
const liveCatalogCache = cache.entries;

function clearLiveCatalogCache(owner: LiveCatalogCache): void {
  owner.entries.clear();
  owner.expiry?.cancel();
  owner.expiry = undefined;
}

function armLiveCatalogExpiry(delayMs: number): void {
  const at = Date.now() + Math.max(1, delayMs);
  if (cache.expiry && cache.expiry.at <= at) {
    return;
  }
  cache.expiry?.cancel();
  // One owner wake must not retain the request context that first populated the cache.
  cache.expiry = {
    at,
    cancel: runInDetachedAsyncContext(() =>
      scheduleAbsoluteDeadline(at, expireLiveCatalogs, undefined, { unref: true }),
    ),
  };
}

function expireLiveCatalogs(): void {
  cache.expiry = undefined;
  const now = Date.now();
  let next = Infinity;
  for (const [key, entry] of liveCatalogCache) {
    if (entry.result.state !== "fulfilled") {
      continue;
    }
    const remaining = entry.expiresAt - (entry.now?.() ?? now);
    if (remaining <= 0) {
      liveCatalogCache.delete(key);
    } else {
      next = Math.min(next, remaining);
    }
  }
  if (next !== Infinity) {
    armLiveCatalogExpiry(next);
  }
}

async function consumeLiveCatalog<T>(entry: LiveCatalogCacheEntry<T>, signal?: AbortSignal) {
  const result = entry.result;
  const value = await racePromiseWithAbortSignal(
    result.state === "pending" ? result.value : Promise.resolve(result.value),
    signal,
    (aborted) => aborted.reason,
  );
  if (entry.retained) {
    recordLiveCatalogExpiry(entry.expiresAt);
  }
  return value;
}

/**
 * Shares pending loads and caches successful values for a short TTL after completion.
 */
export async function getCachedLiveCatalogValue<T>(params: {
  /** Stable JSON-serializable values identifying one provider/config load and result type. */
  keyParts: readonly unknown[];
  /** Loader for the live catalog value when no fresh cache entry exists. */
  load: (signal?: AbortSignal) => Promise<T>;
  /** Cancels this consumer; admitted metadata loads finish within their own deadline. */
  signal?: AbortSignal;
  /** Optional predicate for values that are healthy enough to retain. */
  shouldCache?: (value: T) => boolean;
  /** Successful-value cache lifetime in milliseconds; defaults to a short discovery TTL. */
  ttlMs?: number;
  /** Test hook for deterministic cache expiry. */
  now?: () => number;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const rawNow = params.now?.() ?? Date.now();
  const ttlMs = params.ttlMs ?? 30_000;
  // Uncached callers must neither reuse nor disturb an existing entry.
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return await params.load(params.signal);
  }
  const key = sha256Hex(JSON.stringify(params.keyParts));
  const refresh = consumeLiveCatalogRefresh(key);
  // Different acquisition budgets must not inherit each other's pending transport deadline.
  const budget = getProviderCatalogDiscoveryBudget();
  const pendingKey =
    key +
    ":" +
    JSON.stringify([budget ? (budget.timeoutMs ?? "unscoped") : 5_000, budget?.providerTimeouts]);
  // SAFETY: Callers reuse key parts only for the same catalog loader and result type.
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing?.result.state === "fulfilled" && !refresh && existing.expiresAt > rawNow) {
    return await consumeLiveCatalog(existing, params.signal);
  }
  // SAFETY: The pending alias has the same load identity and stable acquisition budget.
  const shared = liveCatalogCache.get(pendingKey) as LiveCatalogCacheEntry<T> | undefined;
  if (shared?.result.state === "pending" && shared.expiresAt > rawNow) {
    return await consumeLiveCatalog(shared, params.signal);
  }
  liveCatalogCache.delete(key);
  // Read-only metadata may finish and warm the cache after every observer cancels.
  const pending = { state: "pending" as const, value: params.load() };
  const entry: LiveCatalogCacheEntry<T> = {
    expiresAt: rawNow + ttlMs,
    retained: false,
    result: pending,
    now: params.now,
  };
  let completed: { state: "fulfilled"; value: T } | undefined;
  pending.value = pending.value
    .then((resolved) => {
      if (params.shouldCache?.(resolved) ?? true) {
        // A slow success gets a complete TTL without reviving an evicted entry.
        entry.expiresAt = (params.now?.() ?? Date.now()) + ttlMs;
        entry.retained = true;
      }
      completed = { state: "fulfilled", value: resolved };
      return resolved;
    })
    .finally(() => {
      if (completed) {
        entry.result = completed;
      }
      const ownsPending = liveCatalogCache.get(pendingKey) === entry;
      if (ownsPending) {
        liveCatalogCache.delete(pendingKey);
      }
      // Returned healthy values retain their own TTL, but an older or evicted load
      // cannot replace a newer generation's globally reusable result.
      if (liveCatalogCache.get(key) === entry && (!entry.retained || !ownsPending)) {
        liveCatalogCache.delete(key);
      } else if (liveCatalogCache.get(key) === entry) {
        armLiveCatalogExpiry(ttlMs);
      }
    });
  // Auth-scoped catalogs vary by token. Bound retained entries without rejecting
  // new catalogs or canceling consumers of an evicted load.
  pruneMapToMaxSize(liveCatalogCache, LIVE_CATALOG_CACHE_MAX_ENTRIES - 2);
  liveCatalogCache.set(key, entry);
  liveCatalogCache.set(pendingKey, entry);
  return await consumeLiveCatalog(entry, params.signal);
}

/**
 * Clears the process-local live catalog cache for tests and isolated plugin probes.
 */
export function clearLiveCatalogCacheForTests(): void {
  clearLiveCatalogCache(cache);
}

/** Count owner-held payloads without exposing cache keys or inspecting pending work. */
export function getLiveCatalogRetainedData(): DiagnosticWorkerRetainedData[] {
  const values: unknown[] = [];
  let pending = 0;
  for (const entry of new Set(liveCatalogCache.values())) {
    if (entry.result.state === "fulfilled") {
      values.push(entry.result.value);
    } else {
      pending++;
    }
  }
  return [
    { structure: "catalog-source", entries: values.length, ...estimateRetainedDataSize(values) },
    { structure: "catalog-request", entries: pending, approximateBytes: 0 },
  ];
}
