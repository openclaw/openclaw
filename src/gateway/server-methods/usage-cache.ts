import { trackAsyncWork } from "../../shared/async-work-scope.js";

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_CACHE_MAX = 256;

export type UsageCacheEntry<T extends object> = {
  configRef: object;
  value?: T;
  updatedAt?: number;
  inFlight?: Promise<T>;
};

function setUsageCache<T extends object>(
  cache: Map<string, UsageCacheEntry<T>>,
  cacheKey: string,
  entry: UsageCacheEntry<T>,
): void {
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
  load: () => Promise<T>;
  isComplete?: (value: T) => boolean;
}): Promise<T> {
  const { cache, cacheKey, configRef } = params;
  const candidate = cache.get(cacheKey);
  const cached = candidate?.configRef === configRef ? candidate : undefined;
  if (cached?.value && cached.updatedAt && Date.now() - cached.updatedAt < USAGE_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.value && cached.updatedAt ? cached.value : await cached.inFlight;
  }

  const entry: UsageCacheEntry<T> = cached ?? { configRef };
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
        const current = cache.get(cacheKey);
        if (current === entry && current.inFlight === inFlight) {
          current.inFlight = undefined;
        }
      }),
  );

  entry.inFlight = inFlight;
  setUsageCache(cache, cacheKey, entry);
  return entry.value && entry.updatedAt ? entry.value : await inFlight;
}
