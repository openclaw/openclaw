import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "./status.format.js";

describe("formatTokensCompact", () => {
  it("shows token usage without cache info when cacheRead is absent", () => {
    const result = formatTokensCompact({
      totalTokens: 10_000,
      contextTokens: 100_000,
      percentUsed: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
      inputTokens: undefined,
    });
    expect(result).toBe("10k/100k (10%)");
    expect(result).not.toContain("cached");
  });

  it("shows correct cache hit rate using inputTokens as denominator", () => {
    // inputTokens = 10k total input (5k fresh + 5k cache read)
    // cacheRead = 5k  →  50% hit rate
    const result = formatTokensCompact({
      totalTokens: 8_000,
      contextTokens: 100_000,
      percentUsed: 8,
      cacheRead: 5_000,
      cacheWrite: 0,
      inputTokens: 10_000,
    });
    expect(result).toContain("50% cached");
  });

  it("never reports cache hit rate above 100% even if cacheRead exceeds totalTokens", () => {
    // Reproduces the real-world "199% cached" bug:
    // cron sessions accumulate large cacheRead over time while totalTokens
    // (input + output) can be much smaller than cacheRead alone.
    const result = formatTokensCompact({
      totalTokens: 43_000,
      contextTokens: 200_000,
      percentUsed: 21,
      cacheRead: 86_000, // cache reads > total tokens → old code showed 199%
      cacheWrite: 0,
      inputTokens: undefined, // inputTokens not available → falls back to cache-only denominator
    });
    const match = result.match(/(\d+)% cached/);
    expect(match).not.toBeNull();
    const pct = parseInt(match![1], 10);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it("falls back to cache-only denominator when inputTokens is unavailable", () => {
    // cacheRead = 6k, cacheWrite = 2k → denominator = 8k → 75% hit rate
    const result = formatTokensCompact({
      totalTokens: 10_000,
      contextTokens: 100_000,
      percentUsed: 10,
      cacheRead: 6_000,
      cacheWrite: 2_000,
      inputTokens: undefined,
    });
    expect(result).toContain("75% cached");
  });

  it("shows unknown usage when totalTokens is null", () => {
    const result = formatTokensCompact({
      totalTokens: null,
      contextTokens: 100_000,
      percentUsed: null,
      cacheRead: undefined,
      cacheWrite: undefined,
      inputTokens: undefined,
    });
    expect(result).toContain("unknown");
  });
});
