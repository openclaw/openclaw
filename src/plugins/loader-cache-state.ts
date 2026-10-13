import { AsyncLocalStorage } from "node:async_hooks";
import { LruCache } from "../infra/lru-cache.js";

/** Error thrown when one plugin registry cache key attempts nested loading. */
class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

/** Small registry cache with reentry detection and per-key warning memory. */
export class PluginLoaderCacheState<T> {
  readonly #registryCache: LruCache<T>;
  readonly #inFlightLoads = new Set<string>();
  readonly #asyncLoads = new Map<string, Promise<T>>();
  readonly #asyncLoadScope = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
  readonly #openAllowlistWarningCache: LruCache<true>;

  constructor(
    defaultMaxEntries: number,
    private readonly onCache?: (state: T) => void,
  ) {
    this.#registryCache = new LruCache<T>(defaultMaxEntries);
    this.#openAllowlistWarningCache = new LruCache<true>(defaultMaxEntries);
  }

  clear(): void {
    this.#registryCache.clear();
    this.#inFlightLoads.clear();
    this.#openAllowlistWarningCache.clear();
  }

  clearCachedRegistries(): void {
    this.#registryCache.clear();
    this.#openAllowlistWarningCache.clear();
  }

  get(cacheKey: string): T | undefined {
    return this.#registryCache.get(cacheKey);
  }

  set(cacheKey: string, state: T): void {
    this.#registryCache.set(cacheKey, state);
    this.onCache?.(state);
  }

  deleteValue(state: T): void {
    this.#registryCache.deleteValue(state);
  }

  /** Serialize registration while each caller retains its own cache-hit policy. */
  loadAsync(cacheKey: string, load: () => Promise<T>): Promise<T> {
    const parents = this.#asyncLoadScope.getStore();
    if (parents?.get(cacheKey)?.active) {
      return Promise.reject(new PluginLoadReentryError(cacheKey));
    }
    const previous = this.#asyncLoads.get(cacheKey);
    // The predecessor owns its failure; this caller still gets its own load policy.
    const pending = Promise.resolve(previous)
      .catch(() => undefined)
      .then(() => {
        const current = { active: true };
        return this.#asyncLoadScope.run(
          new Map([...(parents ?? []), [cacheKey, current]]),
          async () => {
            try {
              return await load();
            } finally {
              current.active = false;
            }
          },
        );
      })
      .finally(() => {
        if (this.#asyncLoads.get(cacheKey) === pending) {
          this.#asyncLoads.delete(cacheKey);
        }
      });
    this.#asyncLoads.set(cacheKey, pending);
    return pending;
  }

  isLoadInFlight(cacheKey: string): boolean {
    return this.#inFlightLoads.has(cacheKey);
  }

  beginLoad(cacheKey: string): void {
    if (this.#inFlightLoads.has(cacheKey)) {
      throw new PluginLoadReentryError(cacheKey);
    }
    this.#inFlightLoads.add(cacheKey);
  }

  finishLoad(cacheKey: string): void {
    this.#inFlightLoads.delete(cacheKey);
  }

  hasOpenAllowlistWarning(cacheKey: string): boolean {
    return this.#openAllowlistWarningCache.get(cacheKey) === true;
  }

  recordOpenAllowlistWarning(cacheKey: string): void {
    this.#openAllowlistWarningCache.set(cacheKey, true);
  }
}
