/** Process-local LRU storage; callers own freshness and lifecycle. */
export class LruCache<T> {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #sizeOf: ((value: T) => number) | undefined;
  readonly #entries = new Map<string, T>();
  #bytes = 0;

  constructor(maxEntries: number, options?: { maxBytes: number; sizeOf: (value: T) => number }) {
    this.#maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0 ? Math.max(1, Math.floor(maxEntries)) : 1;
    this.#maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#sizeOf = options?.sizeOf;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  keys(): IterableIterator<string> {
    return this.#entries.keys();
  }

  delete(cacheKey: string): boolean {
    if (!this.#entries.has(cacheKey)) {
      return false;
    }
    // SAFETY: has() proved the key exists; undefined remains a valid cached T.
    this.#bytes -= this.#sizeOf?.(this.#entries.get(cacheKey) as T) ?? 0;
    return this.#entries.delete(cacheKey);
  }

  deleteValue(value: T): void {
    for (const [key, entry] of this.#entries) {
      if (entry === value) {
        this.delete(key);
      }
    }
  }

  /** Reads without promoting a value whose revalidation is still pending. */
  peek(cacheKey: string): T | undefined {
    return this.#entries.get(cacheKey);
  }

  /** Returns a cached value and refreshes its recency when present. */
  get(cacheKey: string): T | undefined {
    if (!this.#entries.has(cacheKey)) {
      return undefined;
    }
    // SAFETY: has() proved the key exists; undefined remains a valid cached T.
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return cached;
  }

  /** Stores a value as the newest entry and evicts oldest entries past capacity. */
  set(cacheKey: string, value: T): void {
    this.delete(cacheKey);
    this.#entries.set(cacheKey, value);
    this.#bytes += this.#sizeOf?.(value) ?? 0;
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) {
        break;
      }
      this.delete(key);
    }
  }
}
