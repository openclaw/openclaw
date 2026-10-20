import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { DiagnosticWorkerRetainedData } from "../infra/diagnostic-process-types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { estimateRetainedDataSize } from "../infra/retained-data-size.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { consumeLiveCatalogRefresh, recordLiveCatalogExpiry } from "./provider-catalog-expiry.js";

type LiveCatalogCacheEntry<T> = {
  expiresAt: number;
  result: { state: "pending"; value: Promise<T> } | { state: "fulfilled"; value: T };
  retained: boolean;
};

const LIVE_CATALOG_CACHE_MAX_ENTRIES = 100;
// Preserve the TTL cache across restarts and registry replacement, but release
// its payloads when the final runtime closes.
const liveCatalogCache = resolveGlobalMap<string, LiveCatalogCacheEntry<unknown>>(
  Symbol.for("openclaw.providerLiveCatalogCache"),
  "close-only",
);

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
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  // Uncached callers must neither reuse nor disturb an existing entry.
  if (expiresAt === undefined) {
    return await params.load(params.signal);
  }
  const key = sha256Hex(JSON.stringify(params.keyParts));
  const refresh = consumeLiveCatalogRefresh(key);
  // SAFETY: Callers reuse key parts only for the same catalog loader and result type.
  const existing = liveCatalogCache.get(key) as LiveCatalogCacheEntry<T> | undefined;
  if (existing) {
    if (
      (!refresh || existing.result.state === "pending") &&
      isFutureDateTimestampMs(existing.expiresAt, { nowMs: rawNow })
    ) {
      return await consumeLiveCatalog(existing, params.signal);
    }
    liveCatalogCache.delete(key);
  }
  // Read-only metadata may finish and warm the cache after every observer cancels.
  const pending = { state: "pending" as const, value: params.load() };
  const entry: LiveCatalogCacheEntry<T> = { expiresAt, retained: false, result: pending };
  let completed: { state: "fulfilled"; value: T } | undefined;
  pending.value = pending.value
    .then((resolved) => {
      if (params.shouldCache?.(resolved) ?? true) {
        // A slow success gets a complete TTL without reviving an evicted entry.
        const completedExpiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, {
          nowMs: params.now?.() ?? Date.now(),
        });
        if (completedExpiresAt !== undefined) {
          entry.expiresAt = completedExpiresAt;
          entry.retained = true;
        }
      }
      completed = { state: "fulfilled", value: resolved };
      return resolved;
    })
    .finally(() => {
      if (completed) {
        entry.result = completed;
      }
      if (!entry.retained && liveCatalogCache.get(key) === entry) {
        liveCatalogCache.delete(key);
      }
    });
  // Auth-scoped catalogs vary by token. Bound retained entries without rejecting
  // new catalogs or canceling consumers of an evicted load.
  pruneMapToMaxSize(liveCatalogCache, LIVE_CATALOG_CACHE_MAX_ENTRIES - 1);
  liveCatalogCache.set(key, entry);
  return await consumeLiveCatalog(entry, params.signal);
}

/**
 * Clears the process-local live catalog cache for tests and isolated plugin probes.
 */
export function clearLiveCatalogCacheForTests(): void {
  liveCatalogCache.clear();
}

/** Count owner-held payloads without exposing cache keys or inspecting pending work. */
export function getLiveCatalogRetainedData(): DiagnosticWorkerRetainedData[] {
  const values: unknown[] = [];
  let pending = 0;
  for (const entry of liveCatalogCache.values()) {
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
