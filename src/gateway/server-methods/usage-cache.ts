import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { monotonicNow } from "../../shared/monotonic-time.js";

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_CACHE_MAX = 256;

export type UsageCacheEntry<T extends object> = {
  configRef: object;
  revision: string | number;
  /** Monotonic last-access reading for eviction ordering; never persisted or serialized. */
  lastAccessedMonotonic: number;
  value?: T;
  /** Monotonic completion reading anchoring TTL freshness; never persisted or serialized. */
  updatedAtMonotonic?: number;
  inFlight?: Promise<T>;
};

function setUsageCache<T extends object>(
  cache: Map<string, UsageCacheEntry<T>>,
  cacheKey: string,
  entry: UsageCacheEntry<T>,
  maxEntries: number,
): void {
  const cutoff = monotonicNow() - USAGE_CACHE_TTL_MS;
  for (const [key, candidate] of cache) {
    if (key !== cacheKey && !candidate.inFlight && candidate.lastAccessedMonotonic <= cutoff) {
      cache.delete(key);
    }
  }
  if (!cache.has(cacheKey) && cache.size >= maxEntries) {
    let evictionKey = cache.keys().next().value;
    // Preserve active loads whenever a settled entry can be evicted instead.
    for (const [key, candidate] of cache) {
      if (!candidate.inFlight) {
        evictionKey = key;
        break;
      }
    }
    if (evictionKey !== undefined) {
      cache.delete(evictionKey);
    }
  }
  cache.set(cacheKey, entry);
}

export async function loadUsageResultCached<T extends object>(params: {
  cache: Map<string, UsageCacheEntry<T>>;
  cacheKey: string;
  configRef: object;
  revision: string | number;
  load: () => Promise<T>;
  isComplete?: (value: T) => boolean;
  revisionOnly?: boolean;
  maxEntries?: number;
  shareInFlight?: boolean;
}): Promise<T> {
  const { cache, cacheKey, configRef, revision } = params;
  const nowMonotonic = monotonicNow();
  const candidate = cache.get(cacheKey);
  const cached =
    candidate?.configRef === configRef && candidate.revision === revision ? candidate : undefined;
  if (cached) {
    cached.lastAccessedMonotonic = nowMonotonic;
  }
  if (
    cached?.value &&
    cached.updatedAtMonotonic !== undefined &&
    (params.revisionOnly || nowMonotonic - cached.updatedAtMonotonic < USAGE_CACHE_TTL_MS)
  ) {
    return cached.value;
  }
  if (cached?.inFlight && params.shareInFlight !== false) {
    return cached.value && cached.updatedAtMonotonic !== undefined
      ? cached.value
      : await cached.inFlight;
  }

  // Each request-owned flight may reuse settled data, but owns its publication and cleanup.
  const entry: UsageCacheEntry<T> = cached
    ? { ...cached, inFlight: undefined }
    : { configRef, revision, lastAccessedMonotonic: nowMonotonic };
  // Stale responses and cache eviction do not release the initiating owner's work.
  const inFlight = trackAsyncWork(() =>
    params
      .load()
      .then((value) => {
        if (params.isComplete?.(value) ?? true) {
          entry.value = value;
          entry.updatedAtMonotonic = monotonicNow();
        } else if (!entry.value) {
          // Partial snapshots serve cold callers without masking the next refresh.
          entry.value = value;
          delete entry.updatedAtMonotonic;
        }
        return value;
      })
      .catch((error: unknown) => {
        if (entry.value) {
          return entry.value;
        }
        throw error;
      })
      .finally(() => {
        entry.inFlight = undefined;
        entry.lastAccessedMonotonic = monotonicNow();
      }),
  );

  entry.inFlight = inFlight;
  setUsageCache(cache, cacheKey, entry, params.maxEntries ?? USAGE_CACHE_MAX);
  return entry.value && entry.updatedAtMonotonic !== undefined ? entry.value : await inFlight;
}
