import { describe, expect, it } from "vitest";
import { formatKTokens, formatPromptCacheCompact, formatTokensCompact } from "./status.format.js";

describe("formatKTokens", () => {
  it("renders sub-1000 values as plain integers", () => {
    expect(formatKTokens(0)).toBe("0");
    expect(formatKTokens(420)).toBe("420");
    expect(formatKTokens(999)).toBe("999");
  });

  it("renders 1000+ values as before", () => {
    expect(formatKTokens(1000)).toBe("1.0k");
    expect(formatKTokens(1200)).toBe("1.2k");
    expect(formatKTokens(10_000)).toBe("10k");
    expect(formatKTokens(12_000)).toBe("12k");
  });

  it("no longer rounds 999 up to 1.0k", () => {
    expect(formatKTokens(999)).not.toBe("1.0k");
  });
});

describe("status cache formatting", () => {
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
