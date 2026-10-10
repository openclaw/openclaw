import { trackAsyncWork } from "../../shared/async-work-scope.js";

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_CACHE_MAX = 256;

export type UsageCacheEntry<T extends object> = {
  configRef: object;
  revision: string | number;
  lastAccessedAt: number;
  value?: T;
  updatedAt?: number;
  inFlight?: Promise<T>;
};

function setUsageCache<T extends object>(
  cache: Map<string, UsageCacheEntry<T>>,
  cacheKey: string,
  entry: UsageCacheEntry<T>,
): void {
  const cutoff = Date.now() - USAGE_CACHE_TTL_MS;
  for (const [key, candidate] of cache) {
    if (key !== cacheKey && !candidate.inFlight && candidate.lastAccessedAt <= cutoff) {
      cache.delete(key);
    }
  }
  if (!cache.has(cacheKey) && cache.size >= USAGE_CACHE_MAX) {
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
}): Promise<T> {
  const { cache, cacheKey, configRef, revision } = params;
  const now = Date.now();
  const candidate = cache.get(cacheKey);
  const cached =
    candidate?.configRef === configRef && candidate.revision === revision ? candidate : undefined;
  if (cached) {
    cached.lastAccessedAt = now;
  }
  if (cached?.value && cached.updatedAt && now - cached.updatedAt < USAGE_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.value && cached.updatedAt ? cached.value : await cached.inFlight;
  }

  const entry: UsageCacheEntry<T> = cached ?? { configRef, revision, lastAccessedAt: now };
  // Stale responses and cache eviction do not release the initiating owner's work.
  const inFlight = trackAsyncWork(() =>
    params
      .load()
      .then((value) => {
        if (cache.get(cacheKey) !== entry) {
          return value;
        }
        if (params.isComplete?.(value) ?? true) {
          entry.value = value;
          entry.updatedAt = Date.now();
        } else if (!entry.value) {
          // Partial snapshots serve cold callers without masking the next refresh.
          entry.value = value;
          delete entry.updatedAt;
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
        if (cache.get(cacheKey) === entry && entry.inFlight === inFlight) {
          entry.inFlight = undefined;
          entry.lastAccessedAt = Date.now();
        }
      }),
  );

  entry.inFlight = inFlight;
  setUsageCache(cache, cacheKey, entry);
  return entry.value && entry.updatedAt ? entry.value : await inFlight;
}
