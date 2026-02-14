/**
 * Example showing how to migrate from simple Map cache to CacheManager
 * This demonstrates how to integrate the new caching layer with existing tools
 */

import { getGlobalCache } from "./index.js";
import { createCachedWebSearch } from "./integrations/web-search-cache.js";

// Example: Wrap existing web search function with caching
export function migrateWebSearchToNewCache(originalSearchFn: any) {
  const cache = getGlobalCache({
    maxSizeInMB: 50, // 50MB for web searches
    enableMetrics: true,
  });

  return createCachedWebSearch(cache, originalSearchFn);
}

// Example: How to integrate with tool definitions
export function enhanceToolWithCache(toolDefinition: any) {
  const cache = getGlobalCache();

  // If it's a web search tool
  if (toolDefinition.name === "web_search") {
    const originalHandler = toolDefinition.handler;
    toolDefinition.handler = createCachedWebSearch(cache, originalHandler);
  }

  // Add similar enhancements for other tools
  // ...

  return toolDefinition;
}

// Example: Performance monitoring
export function startCacheMonitoring() {
  const cache = getGlobalCache();

  setInterval(async () => {
    const report = await cache.getEffectivenessReport();

    if (report.summary.totalHitRate > 0) {
      console.log(`[Cache] Performance Report:
  - Hit Rate: ${report.summary.totalHitRate.toFixed(1)}%
  - API Calls Saved: ${report.summary.apiCallsSaved}
  - Avg Latency Reduction: ${report.summary.avgLatencyReduction.toFixed(0)}ms
  - Memory Used: ${(report.summary.memorySaved / 1024 / 1024).toFixed(2)}MB`);

      // Log per-resource stats
      for (const resource of report.byResource) {
        if (resource.entries > 0) {
          console.log(
            `  [${resource.type}]: ${resource.entries} entries, ${resource.hitRate.toFixed(1)}% hit rate`,
          );
        }
      }
    }
  }, 300000); // Every 5 minutes
}

// Example: How to use in tests
export async function runCacheIntegrationTests() {
  const cache = getGlobalCache({
    maxSizeInMB: 10,
    enableMetrics: true,
  });

  // Clear cache before tests
  await cache.clearAll();

  // Run tests with cached operations
  const mockSearchFn = async (params: any) => {
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { results: [`Result for ${params.query}`] };
  };

  const cachedSearch = createCachedWebSearch(cache, mockSearchFn);

  // First call - cache miss
  const result1 = await cachedSearch({ query: "test query" });
  console.assert(!result1.cached, "First call should be a cache miss");

  // Second call - cache hit
  const result2 = await cachedSearch({ query: "test query" });
  console.assert(result2.cached, "Second call should be a cache hit");

  // Get effectiveness report
  const report = await cache.getEffectivenessReport();
  console.log("Test Results:", {
    hitRate: report.summary.totalHitRate,
    apiCallsSaved: report.summary.apiCallsSaved,
  });

  return report.summary.totalHitRate >= 50; // At least 50% hit rate
}
