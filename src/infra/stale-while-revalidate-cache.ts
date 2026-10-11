import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { pruneMapToMaxSize } from "./map-size.js";

type CacheEntry<T> = { expiresAt: number } & (
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
);

export function createStaleWhileRevalidateCache<T>(options: {
  maxEntries: number;
  maxPending?: number;
  ttlMs: number;
  cacheable?: (value: T) => boolean;
  errorTtlMs?: (error: unknown) => number;
  onBackgroundError?: (error: unknown) => void;
}) {
  let values = new Map<string, CacheEntry<T>>();
  let pending = new Map<string, Promise<T>>();
  let active = 0;
  return {
    async read(
      key: string,
      load: (background: boolean) => Promise<T>,
      readOptions: { allowStale?: boolean; refresh?: boolean } = {},
    ): Promise<{ value: T; stale: boolean }> {
      const entries = values;
      const loads = pending;
      const cached = entries.get(key);
      if (!readOptions.refresh && cached && cached.expiresAt > Date.now()) {
        if (cached.kind === "error") {
          throw cached.error;
        }
        return { value: cached.value, stale: false };
      }
      const stale =
        !readOptions.refresh && readOptions.allowStale !== false && cached?.kind === "value"
          ? cached
          : undefined;
      if (
        (!loads.has(key) || readOptions.refresh) &&
        active >= (options.maxPending ?? options.maxEntries)
      ) {
        if (stale) {
          return { value: stale.value, stale: true };
        }
        throw new Error("Read cache is busy; retry shortly.");
      }
      if (readOptions.refresh) {
        loads.delete(key);
      }
      let refresh: Promise<T> | undefined;
      refresh = getOrCreatePromise(
        loads,
        key,
        async () => {
          active += 1;
          try {
            const value = await load(Boolean(stale));
            if (loads.get(key) !== refresh) {
              return value;
            }
            if (options.cacheable?.(value) !== false) {
              entries.set(key, {
                kind: "value",
                value,
                expiresAt: Date.now() + options.ttlMs,
              });
              pruneMapToMaxSize(entries, options.maxEntries);
            } else {
              entries.delete(key);
            }
            return value;
          } catch (error) {
            if (loads.get(key) === refresh) {
              entries.delete(key);
              const ttl = options.errorTtlMs?.(error) ?? 0;
              if (ttl > 0) {
                entries.set(key, { kind: "error", error, expiresAt: Date.now() + ttl });
                pruneMapToMaxSize(entries, options.maxEntries);
              }
              if (stale) {
                options.onBackgroundError?.(error);
              }
            }
            throw error;
          } finally {
            active -= 1;
          }
        },
        { evictOnSettled: true },
      );
      if (stale) {
        void refresh.catch(() => {});
        return { value: stale.value, stale: true };
      }
      return { value: await refresh, stale: false };
    },
    clear() {
      // Existing loads may settle, but only into the retired maps they captured.
      values = new Map();
      pending = new Map();
    },
  };
}
