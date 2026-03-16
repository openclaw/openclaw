import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "./status.format.js";

describe("formatTokensCompact", () => {
  it("computes cache percentage from prompt tokens instead of total session tokens", () => {
    expect(
      formatTokensCompact({
        inputTokens: 2_000,
        cacheRead: 400_000,
        cacheWrite: 1_000,
        totalTokens: 2_500,
        contextTokens: 1_000_000,
        percentUsed: 0,
      }),
    ).toContain("99% cached");
  });

  it("keeps the existing cache ratio for normal sessions", () => {
    expect(
      formatTokensCompact({
        inputTokens: 2_000,
        cacheRead: 2_000,
        cacheWrite: 1_000,
        totalTokens: 5_000,
        contextTokens: 10_000,
        percentUsed: 50,
      }),
    ).toContain("40% cached");
  });
});
