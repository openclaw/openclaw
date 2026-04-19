// Regression: costUsageCache (usage.ts:65) has no production delete/prune/evict
// path. The TTL at L310 is read-only — on a miss after expiry, set() overwrites
// the same key but never removes stale keys. parseDateRange derives cacheKey
// from getTodayStartMs so cacheKey rolls at every UTC 00:00, and additional
// axes (days, startDate, endDate, utcOffset) multiply cardinality.
//
// The same file has three sibling caches that implement MAX + FIFO eviction
// (resolvedSessionKeyByRunId, TRANSCRIPT_SESSION_KEY_CACHE,
// sessionTitleFieldsCache); costUsageCache alone lacked the pattern.
//
// Production trigger: MenuSessionsInjector polls usage.cost every ~45s with
// no params, exercising parseDateRange's default branch on every UTC day
// rollover. The Control UI adds more key variance via explicit startDate /
// endDate / utcTimeZone combinations.
//
// CAL-003 compliance: no mock of internal branches. Growth is driven through
// the __test.loadCostUsageSummaryCached seam (same entry point usage.test.ts
// already exercises) with distinct (startMs, endMs) pairs. Only the external
// loadCostUsageSummary dependency is stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      daily: [],
      totals: {
        totalTokens: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalCost: 0,
      },
    })),
  };
});

import { __test } from "./usage.js";

describe("costUsageCache bounded growth", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    __test.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not grow without bound when (startMs, endMs) varies across day rollover and range switches", async () => {
    const config = {} as OpenClawConfig;

    // 600 distinct (startMs, endMs) pairs — larger than the 256 caps used by
    // the smallest sibling caches (RUN_LOOKUP_CACHE_LIMIT,
    // TRANSCRIPT_SESSION_KEY_CACHE_MAX) and small enough that the test runs
    // quickly.
    const ITERATIONS = 600;

    for (let i = 0; i < ITERATIONS; i++) {
      const startMs = Date.UTC(2026, 0, 1) + i * DAY_MS;
      const endMs = startMs + (i % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
      await __test.loadCostUsageSummaryCached({ startMs, endMs, config });
    }

    // Primary: map must be bounded. Pre-fix this equals ITERATIONS (600).
    expect(__test.costUsageCache.size).toBeLessThan(ITERATIONS);

    // Secondary: the most recent entry must still be present. FIFO evicts
    // oldest-first, never the newest.
    const lastStartMs = Date.UTC(2026, 0, 1) + (ITERATIONS - 1) * DAY_MS;
    const lastEndMs = lastStartMs + ((ITERATIONS - 1) % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
    const lastCacheKey = `${lastStartMs}-${lastEndMs}`;
    expect(__test.costUsageCache.has(lastCacheKey)).toBe(true);

    // Tertiary: the oldest entry must have been evicted once the cap was
    // exceeded. Pre-fix all 600 entries remain and this fails too.
    const firstStartMs = Date.UTC(2026, 0, 1);
    const firstEndMs = firstStartMs + DAY_MS - 1;
    const firstCacheKey = `${firstStartMs}-${firstEndMs}`;
    expect(__test.costUsageCache.has(firstCacheKey)).toBe(false);
  });
});
