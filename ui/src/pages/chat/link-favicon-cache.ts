export type LinkFaviconFetcher = (hostname: string, signal: AbortSignal) => Promise<string | null>;

type Favicon = {
  value: string | null | undefined;
  subscribers: Set<() => void>;
  controller: AbortController;
  timeout: number;
};

type FaviconCache = { entries: Map<string, Favicon>; scopes: number };
const MAX_FAVICONS = 128;
const caches = new WeakMap<LinkFaviconFetcher, FaviconCache>();

function faviconCache(fetcher: LinkFaviconFetcher): FaviconCache {
  let cache = caches.get(fetcher);
  if (!cache) {
    cache = { entries: new Map(), scopes: 0 };
    caches.set(fetcher, cache);
  }
  return cache;
}

function trim(cache: FaviconCache) {
  for (const [hostname, entry] of cache.entries) {
    if (cache.scopes > 0 && cache.entries.size <= MAX_FAVICONS) {
      return;
    }
    if (entry.subscribers.size > 0) {
      continue;
    }
    cache.entries.delete(hostname);
    window.clearTimeout(entry.timeout);
    entry.controller.abort();
    if (entry.value) {
      URL.revokeObjectURL(entry.value);
    }
  }
}

/** A transcript or browser retains a bounded warm cache across row/tab remounts. */
export function retainLinkFaviconCache(fetcher: LinkFaviconFetcher): () => void {
  const cache = faviconCache(fetcher);
  cache.scopes += 1;
  return () => {
    cache.scopes -= 1;
    trim(cache);
  };
}

export function hasLinkFavicon(hostname: string, fetcher: LinkFaviconFetcher): boolean {
  return caches.get(fetcher)?.entries.has(hostname) ?? false;
}

export function createLinkFaviconReader(onSettled: () => void) {
  const notify = () => onSettled();
  let current:
    | { hostname: string; fetcher: LinkFaviconFetcher; cache: FaviconCache; entry: Favicon }
    | undefined;
  const dispose = () => {
    const held = current;
    current = undefined;
    if (!held) {
      return;
    }
    const { cache, entry } = held;
    entry.subscribers.delete(notify);
    trim(cache);
  };

  return {
    dispose,
    read(hostname: string, fetcher: LinkFaviconFetcher): string | null | undefined {
      if (current?.hostname === hostname && current.fetcher === fetcher) {
        return current.entry.value;
      }
      dispose();
      const cache = faviconCache(fetcher);
      let entry = cache.entries.get(hostname);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          value: undefined,
          subscribers: new Set(),
          controller,
          timeout: window.setTimeout(() => controller.abort(), 15_000),
        };
        const pending = entry;
        cache.entries.set(hostname, entry);
        void fetcher(hostname, controller.signal)
          .catch(() => null)
          .then((url) => {
            // A fetcher may finish after its final reader released the request.
            if (cache.entries.get(hostname) !== pending) {
              if (url) {
                URL.revokeObjectURL(url);
              }
              return;
            }
            pending.value = url;
            for (const subscriber of pending.subscribers) {
              subscriber();
            }
          })
          .finally(() => window.clearTimeout(pending.timeout));
      }
      cache.entries.delete(hostname);
      cache.entries.set(hostname, entry);
      entry.subscribers.add(notify);
      current = { hostname, fetcher, cache, entry };
      trim(cache);
      return entry.value;
    },
  };
}
