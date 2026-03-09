/**
 * Lightweight LRU cache backed by a Map.
 * Leverages Map insertion-order: on access, entries are moved to the end
 * (delete + re-insert). On overflow, the first (oldest) entry is evicted.
 */
export class LruMap<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new Error(`LruMap maxSize must be a positive integer, got: ${maxSize}`);
    }
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
