/**
 * Web search caching integration
 * Wraps web search operations with intelligent caching
 */

import type { CacheManager } from "../cache-manager.js";

export type WebSearchParams = {
  query: string;
  count?: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  provider?: string;
};

export type WebSearchResult = {
  results: Array<{
    title?: string;
    url?: string;
    description?: string;
    snippet?: string;
  }>;
  cached?: boolean;
  cacheKey?: string;
};

/**
 * Create a cached web search function
 */
export function createCachedWebSearch(
  cache: CacheManager,
  originalSearch: (params: WebSearchParams) => Promise<WebSearchResult>,
) {
  return async function cachedWebSearch(params: WebSearchParams): Promise<WebSearchResult> {
    // Don't cache searches with freshness requirements
    if (params.freshness && ["pd", "pw"].includes(params.freshness)) {
      const result = await originalSearch(params);
      return { ...result, cached: false };
    }

    // Create cache key from search params
    const cacheKey = {
      query: params.query.toLowerCase().trim(),
      count: params.count || 5,
      country: params.country || "US",
      lang: params.search_lang || "en",
      provider: params.provider || "brave",
    };

    // Try to get from cache or fetch
    const { value, cached } = await cache.getOrSet(
      "web-search",
      cacheKey,
      async () => {
        const result = await originalSearch(params);
        return result;
      },
      {
        // Shorter TTL for news-like queries
        ttl: isNewsQuery(params.query) ? 300 : 900, // 5 or 15 minutes
        tags: ["search", params.provider || "brave"],
      },
    );

    return {
      ...value,
      cached,
      cacheKey: JSON.stringify(cacheKey),
    };
  };
}

/**
 * Check if a query is likely news-related and needs fresher results
 */
function isNewsQuery(query: string): boolean {
  const newsKeywords = [
    "news",
    "today",
    "latest",
    "breaking",
    "current",
    "recent",
    "update",
    "yesterday",
    "this week",
  ];

  const lowerQuery = query.toLowerCase();
  return newsKeywords.some((keyword) => lowerQuery.includes(keyword));
}

/**
 * Invalidate cached searches by query pattern
 */
export async function invalidateSearchCache(
  cache: CacheManager,
  pattern?: string | RegExp,
): Promise<number> {
  if (!pattern) {
    // Clear all web search caches
    return cache.invalidateResourceType("web-search");
  }

  // TODO: Implement pattern-based invalidation
  // For now, clear all if pattern is provided
  return cache.invalidateResourceType("web-search");
}
