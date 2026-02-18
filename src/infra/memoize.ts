/**
 * Memoization Utilities
 * Cache function results with TTL and key customization
 */

export interface MemoizeOptions<_T> {
  ttlMs?: number;
  maxSize?: number;
  keyFn?: (...args: unknown[]) => string;
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export function memoize<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  options: MemoizeOptions<TReturn> = {},
): (...args: TArgs) => TReturn {
  const cache = new Map<string, CacheEntry<TReturn>>();
  const ttlMs = options.ttlMs ?? 60_000;
  const maxSize = options.maxSize ?? 100;
  const keyFn = options.keyFn ?? ((...args: unknown[]) => JSON.stringify(args));

  return (...args: TArgs): TReturn => {
    const key = keyFn(...args);
    const entry = cache.get(key);

    if (entry && Date.now() < entry.expiresAt) {
      return entry.value;
    }

    const result = fn(...args);

    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey) {
        cache.delete(firstKey);
      }
    }

    cache.set(key, {
      value: result,
      expiresAt: Date.now() + ttlMs,
    });

    return result;
  };
}

export function memoizeAsync<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: MemoizeOptions<TReturn> = {},
): (...args: TArgs) => Promise<TReturn> {
  const cache = new Map<string, CacheEntry<TReturn>>();
  const ttlMs = options.ttlMs ?? 60_000;
  const maxSize = options.maxSize ?? 100;
  const keyFn = options.keyFn ?? ((...args: unknown[]) => JSON.stringify(args));
  const pending = new Map<string, Promise<TReturn>>();

  return async (...args: TArgs): Promise<TReturn> => {
    const key = keyFn(...args);
    const entry = cache.get(key);

    if (entry && Date.now() < entry.expiresAt) {
      return entry.value;
    }

    if (pending.has(key)) {
      return pending.get(key)!;
    }

    const promise = fn(...args);
    pending.set(key, promise);

    try {
      const result = await promise;

      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      cache.set(key, {
        value: result,
        expiresAt: Date.now() + ttlMs,
      });

      return result;
    } finally {
      pending.delete(key);
    }
  };
}
