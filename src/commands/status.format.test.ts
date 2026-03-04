import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "./status.format.js";

describe("formatTokensCompact", () => {
  it("keeps existing cached percentage behavior for normal totals", () => {
    const formatted = formatTokensCompact({
      totalTokens: 5_000,
      contextTokens: 10_000,
      percentUsed: 50,
      cacheRead: 2_000,
      cacheWrite: 1_000,
    });

    expect(formatted).toContain("40% cached");
  });

  it("caps cached percentage at 100% when usage totals are stale", () => {
    const formatted = formatTokensCompact({
      totalTokens: 280,
      contextTokens: 200_000,
      percentUsed: 0,
      cacheRead: 3_200,
      cacheWrite: 0,
    });

    expect(formatted).toContain("100% cached");
  });
});
