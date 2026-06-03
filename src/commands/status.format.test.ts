import { describe, expect, it } from "vitest";
import {
  formatKTokens,
  formatPromptCacheCompact,
  formatTokensCompact,
} from "./status.format.js";

describe("formatKTokens", () => {
  it("renders sub-1000 values as plain integers so 999 does not look like 1k", () => {
    expect(formatKTokens(0)).toBe("0");
    expect(formatKTokens(420)).toBe("420");
    expect(formatKTokens(999)).toBe("999");
  });

  it("keeps the existing fractional-k rendering for >=1000 values", () => {
    expect(formatKTokens(1000)).toBe("1.0k");
    expect(formatKTokens(9999)).toBe("10.0k");
    expect(formatKTokens(12_000)).toBe("12k");
  });
});

describe("status cache formatting", () => {
  it("renders small-session token totals without the misleading k suffix", () => {
    expect(
      formatTokensCompact({
        inputTokens: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 420,
        contextTokens: 200_000,
        percentUsed: 0,
      }),
    ).toBe("420/200k (0%)");
  });

  it("renders small-cache read/write counts as integers", () => {
    expect(
      formatPromptCacheCompact({
        inputTokens: 9_000,
        cacheRead: 12_000,
        cacheWrite: 300,
        totalTokens: 21_300,
      }),
    ).toBe("56% hit · read 12k · write 300");
  });
});

describe("status cache formatting (legacy)", () => {
  it("formats explicit cache details for verbose status output", () => {
    expect(
      formatPromptCacheCompact({
        inputTokens: 2_000,
        cacheRead: 2_000,
        cacheWrite: 1_000,
        totalTokens: 5_000,
      }),
    ).toBe("40% hit · read 2.0k · write 1.0k");
  });

  it("shows cache writes even before there is a cache hit", () => {
    expect(
      formatPromptCacheCompact({
        inputTokens: 2_000,
        cacheRead: 0,
        cacheWrite: 1_000,
        totalTokens: 3_000,
      }),
    ).toBe("0% hit · write 1.0k");
  });

  it("keeps the compact token suffix aligned with prompt-side cache math", () => {
    expect(
      formatTokensCompact({
        inputTokens: 500,
        cacheRead: 2_000,
        cacheWrite: 500,
        totalTokens: 5_000,
        contextTokens: 10_000,
        percentUsed: 50,
      }),
    ).toBe("5.0k/10k (50%) · 🗄️ 67% cached");
  });
});
