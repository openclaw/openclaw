import type { CostUsageTotals } from "./session-cost-usage.js";

/**
 * Cost query batching utility.
 * Allows loading multiple aggregation types (daily, monthly, yearly) in a single scan.
 * This reduces file I/O and processing time when querying multiple time horizons.
 */

export type CostUsageMetaCache = {
  daily?: Array<CostUsageTotals & { date: string }>;
  monthly?: Array<CostUsageTotals & { month: string }>;
  yearly?: Array<CostUsageTotals & { year: string }>;
  totals: CostUsageTotals;
  generatedAt: number;
};

/**
 * Extracted cost aggregation from cached result.
 * This is a flexible type that can represent daily, monthly, or yearly aggregations.
 */
export type ExtractedCostAggregation = {
  updatedAt: number;
  totals: CostUsageTotals;
  daily?: Array<CostUsageTotals & { date: string }>;
  monthly?: Array<CostUsageTotals & { month: string }>;
  yearly?: Array<CostUsageTotals & { year: string }>;
};

/**
 * Interface for coordinating batched cost aggregation.
 * Allows multiple aggregation types to be computed from a single file scan.
 */
export class CostQueryBatcher {
  private aggregations: Map<"daily" | "monthly" | "yearly", boolean> = new Map();
  private cache: Map<string, CostUsageMetaCache> = new Map();

  addAggregationType(type: "daily" | "monthly" | "yearly"): this {
    this.aggregations.set(type, true);
    return this;
  }

  hasAggregationType(type: "daily" | "monthly" | "yearly"): boolean {
    return this.aggregations.has(type);
  }

  getAggregationTypes(): Array<"daily" | "monthly" | "yearly"> {
    return Array.from(this.aggregations.keys());
  }

  /**
   * Cache result from batched aggregation
   */
  cacheResult(cacheKey: string, result: CostUsageMetaCache): void {
    this.cache.set(cacheKey, result);
  }

  /**
   * Retrieve cached result if available
   */
  getCachedResult(cacheKey: string): CostUsageMetaCache | undefined {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return undefined;
    }

    // Check if cache is still fresh (< 30 seconds old)
    if (Date.now() - cached.generatedAt > 30_000) {
      this.cache.delete(cacheKey);
      return undefined;
    }

    return cached;
  }

  /**
   * Extract a specific aggregation from cached result
   */
  extractAggregation(
    result: CostUsageMetaCache,
    type: "daily" | "monthly" | "yearly",
  ): ExtractedCostAggregation | null {
    const aggregation =
      type === "daily"
        ? result.daily
        : type === "monthly"
          ? result.monthly
          : type === "yearly"
            ? result.yearly
            : null;

    if (!aggregation) {
      return null;
    }

    return {
      updatedAt: result.generatedAt,
      [type]: aggregation,
      totals: result.totals,
    };
  }
}

/**
 * Create a cache key for batched cost queries
 */
export function createBatchedCostCacheKey(
  days: number,
  types: Array<"daily" | "monthly" | "yearly">,
): string {
  const typeStr = types.toSorted().join(",");
  return `batched:${days}:${typeStr}`;
}
