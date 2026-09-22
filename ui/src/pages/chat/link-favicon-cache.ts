import type { LinkFaviconFetcher } from "./link-favicon-loader.ts";

// Retain blob URLs for the page lifetime: header tabs reuse them across renders.
const favicons = new Map<string, string | null>();
const inFlight = new Map<string, Set<() => void>>();

export function readLinkFavicon(
  hostname: string,
  fetcher: LinkFaviconFetcher,
  onSettled: () => void,
): string | null | undefined {
  const cached = favicons.get(hostname);
  if (cached !== undefined) {
    return cached;
  }
  const pending = inFlight.get(hostname);
  if (pending) {
    pending.add(onSettled);
    return undefined;
  }
  const listeners = new Set([onSettled]);
  inFlight.set(hostname, listeners);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  void fetcher(hostname, controller.signal)
    .then(
      (url) => favicons.set(hostname, url),
      () => favicons.set(hostname, null),
    )
    .finally(() => {
      window.clearTimeout(timeout);
      inFlight.delete(hostname);
      for (const listener of listeners) {
        listener();
      }
    });
  return undefined;
}
