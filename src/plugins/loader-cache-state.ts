import { LruCache } from "../infra/lru-cache.js";

/** Small registry cache with reentry detection and per-key warning memory. */
export class PluginLoaderCacheState<T> {
  readonly #registryCache: LruCache<T>;
  readonly #inFlightLoads = new Set<string>();
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

  isLoadInFlight(cacheKey: string): boolean {
    return this.#inFlightLoads.has(cacheKey);
  }

  beginLoad(cacheKey: string): void {
    if (this.#inFlightLoads.has(cacheKey)) {
      throw new Error(`plugin load reentry detected for cache key: ${cacheKey}`);
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
