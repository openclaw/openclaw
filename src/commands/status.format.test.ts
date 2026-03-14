import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "./status.format.js";

describe("formatTokensCompact", () => {
  it("formats a standard cache percentage", () => {
    const label = formatTokensCompact({
      totalTokens: 5_000,
      contextTokens: 20_000,
      percentUsed: 25,
      cacheRead: 2_000,
      cacheWrite: 1_000,
    });
    expect(label).toContain("40% cached");
  });

  it("caps cache percentage at 100 when cacheRead exceeds session total", () => {
    const label = formatTokensCompact({
      totalTokens: 12_000,
      contextTokens: 200_000,
      percentUsed: 6,
      cacheRead: 137_000,
      cacheWrite: 0,
    });
    expect(label).toContain("100% cached");
  });
});
