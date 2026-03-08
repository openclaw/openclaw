import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "./status.format.js";

describe("formatTokensCompact", () => {
  it("formats used/context with percentage", () => {
    const result = formatTokensCompact({
      totalTokens: 5000,
      contextTokens: 10000,
      percentUsed: 50,
    });
    expect(result).toBe("5.0k/10k (50%)");
  });

  it("appends cache hit rate when cacheRead > 0", () => {
    const result = formatTokensCompact({
      totalTokens: 10000,
      contextTokens: 20000,
      percentUsed: 50,
      cacheRead: 8000,
    });
    expect(result).toContain("80% cached");
  });

  it("does not show Infinity when totalTokens is 0 and cacheRead > 0", () => {
    const result = formatTokensCompact({
      totalTokens: 0,
      contextTokens: 10000,
      percentUsed: 0,
      cacheRead: 500,
    });
    expect(result).not.toContain("Infinity");
    expect(result).not.toContain("cached");
  });

  it("does not show cache rate when cacheRead is 0", () => {
    const result = formatTokensCompact({
      totalTokens: 5000,
      contextTokens: 10000,
      percentUsed: 50,
      cacheRead: 0,
    });
    expect(result).not.toContain("cached");
  });

  it("handles missing totalTokens with cacheRead", () => {
    const result = formatTokensCompact({
      totalTokens: undefined as unknown as number,
      contextTokens: 10000,
      cacheRead: 3000,
      cacheWrite: 7000,
    });
    expect(result).toContain("30% cached");
  });

  it("handles used-only (no context)", () => {
    const result = formatTokensCompact({
      totalTokens: 5000,
    });
    expect(result).toBe("5.0k used");
  });
});
