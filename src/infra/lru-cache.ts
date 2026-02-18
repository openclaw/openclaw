/**
 * LRU Cache Implementation
 * High-performance Least Recently Used cache with TTL support
 */

export interface LRUCacheOptions<T> {
  maxSize?: number;
  ttlMs?: number;
  onEvict?: (key: string, value: T) => void;
}

export class LRUCache<T> {
  private cache = new Map<string, { value: T; expiresAt?: number }>();
  private maxSize: number;
  private ttlMs: number;
  private onEvict?: (key: string, value: T) => void;

  constructor(options: LRUCacheOptions<T> = {}) {
    this.maxSize = options.maxSize ?? 100;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.onEvict = options.onEvict;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const evicted = this.cache.get(firstKey);
        if (evicted) {
          this.onEvict?.(firstKey, evicted.value);
        }
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : this.ttlMs ? Date.now() + this.ttlMs : undefined,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  values(): T[] {
    const now = Date.now();
    const result: T[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key);
        continue;
      }
      result.push(entry.value);
    }
    return result;
  }
}

export function createLRUCache<T>(options?: LRUCacheOptions<T>): LRUCache<T> {
  return new LRUCache(options);
}
