/**
 * Simple LRU (Least Recently Used) Map with a maximum size cap.
 *
 * On `set`, if the map exceeds `maxSize`, the least-recently-used entry is
 * evicted. On `get`, the accessed entry is promoted to most-recently-used.
 *
 * Uses a plain `Map` internally — `Map` iteration order in JS follows
 * insertion order, so "delete then re-set" moves an entry to the end.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  readonly maxSize: number;

  constructor(maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new Error("LruMap maxSize must be a positive integer");
    }
    this.maxSize = Math.floor(maxSize);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined && !this.map.has(key)) {
      return undefined;
    }
    // Promote to most-recently-used
    this.map.delete(key);
    this.map.set(key, value as V);
    return value;
  }

  /** Read without promoting (useful for iteration/inspection). */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      } else {
        break;
      }
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): MapIterator<K> {
    return this.map.keys();
  }

  values(): MapIterator<V> {
    return this.map.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries();
  }

  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void {
    this.map.forEach(callbackfn);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }
}
