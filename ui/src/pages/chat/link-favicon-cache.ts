export type LinkFaviconFetcher = (hostname: string, signal: AbortSignal) => Promise<string | null>;

type Favicon = {
  value: string | null | undefined;
  subscribers: Set<() => void>;
  controller: AbortController;
  timeout: number;
};

// Share requests and URLs across mounted consumers of the same Gateway context.
const caches = new WeakMap<LinkFaviconFetcher, Map<string, Favicon>>();

export function createLinkFaviconReader(onSettled: () => void) {
  const notify = () => onSettled();
  let current:
    | { hostname: string; fetcher: LinkFaviconFetcher; cache: Map<string, Favicon>; entry: Favicon }
    | undefined;
  const dispose = () => {
    const held = current;
    current = undefined;
    if (!held) {
      return;
    }
    const { hostname, cache, entry } = held;
    entry.subscribers.delete(notify);
    if (entry.subscribers.size === 0) {
      cache.delete(hostname);
      window.clearTimeout(entry.timeout);
      entry.controller.abort();
      if (entry.value) {
        URL.revokeObjectURL(entry.value);
      }
    }
  };

  return {
    dispose,
    read(hostname: string, fetcher: LinkFaviconFetcher): string | null | undefined {
      if (current?.hostname === hostname && current.fetcher === fetcher) {
        return current.entry.value;
      }
      dispose();
      let cache = caches.get(fetcher);
      if (!cache) {
        cache = new Map();
        caches.set(fetcher, cache);
      }
      let entry = cache.get(hostname);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          value: undefined,
          subscribers: new Set(),
          controller,
          timeout: window.setTimeout(() => controller.abort(), 15_000),
        };
        const pending = entry;
        cache.set(hostname, entry);
        void fetcher(hostname, controller.signal)
          .catch(() => null)
          .then((url) => {
            // A fetcher may finish after its final reader released the request.
            if (pending.subscribers.size === 0) {
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
      entry.subscribers.add(notify);
      current = { hostname, fetcher, cache, entry };
      return entry.value;
    },
  };
}
