import { LruCache } from "../infra/lru-cache.js";

// Exact icon URLs learned from authenticated ClawHub catalog responses.
const MAX_CATALOG_ICON_URLS = 1_024;

const catalogIconUrls = new LruCache<string>(MAX_CATALOG_ICON_URLS);

export function normalizeCatalogIconUrl(value: string): string | undefined {
  if (!value || value.length > 2_048) {
    return undefined;
  }
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash
    ? url.href
    : undefined;
}

export function registerClawHubCatalogIconUrls(values: Iterable<string | undefined>): void {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = normalizeCatalogIconUrl(value);
    if (!normalized) {
      continue;
    }
    catalogIconUrls.set(normalized, normalized);
  }
}

export function resolveClawHubCatalogIconUrl(value: string): string | undefined {
  const normalized = normalizeCatalogIconUrl(value);
  return normalized ? catalogIconUrls.peek(normalized) : undefined;
}
