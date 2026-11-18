import { describe, expect, it } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { formatTokenUsageDisplay, resolveTotalTokens, truncateLine } from "./subagents-format.js";

const freshUsage = (totalTokens: number) => ({
  totalTokens,
  totalTokensFresh: true,
  totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
});

describe("shared/subagents-format", () => {
  it("formats token counts with integer, kilo, and million branches", () => {
    expect(formatTokenUsageDisplay()).toBe("");
    expect(formatTokenUsageDisplay(freshUsage(999.9))).toBe("tokens 999 context");
    expect(formatTokenUsageDisplay(freshUsage(1_500))).toBe("tokens 1.5k context");
    expect(formatTokenUsageDisplay(freshUsage(10_000))).toBe("tokens 10k context");
    expect(formatTokenUsageDisplay(freshUsage(15_400))).toBe("tokens 15k context");
    // Rollover boundary: rounding to thousands must not emit an out-of-scheme
    // "1000k" — it has to advance to the million branch.
    expect(formatTokenUsageDisplay(freshUsage(999_499))).toBe("tokens 999k context");
    expect(formatTokenUsageDisplay(freshUsage(999_500))).toBe("tokens 1m context");
    expect(formatTokenUsageDisplay(freshUsage(999_999))).toBe("tokens 1m context");
    expect(formatTokenUsageDisplay(freshUsage(1_000_000))).toBe("tokens 1m context");
    expect(formatTokenUsageDisplay(freshUsage(1_250_000))).toBe("tokens 1.3m context");
  });

  it("keeps truncated lines within the requested max length", () => {
    for (const maxLength of [0, 1, 2, 3, 4, 5, 7, 12]) {
      const result = truncateLine("abcdefghij", maxLength);
      expect(result.length).toBeLessThanOrEqual(maxLength);
    }
    expect(truncateLine("abcdefghij", 0)).toBe("");
    expect(truncateLine("abcdefghij", 1)).toBe(".");
    expect(truncateLine("abcdefghij", 2)).toBe("..");
    expect(truncateLine("abcdefghij", 3)).toBe("...");
  });

  it("truncates without breaking surrogate pairs", () => {
    // Emoji at the cut point: the surrogate pair must not be split.
    expect(truncateLine("AB🤖CDEF", 6)).toBe("AB...");
    // Cut point in the middle of a 3-emoji string.
    expect(truncateLine("🤖🤖🤖", 5)).toBe("🤖...");
    // CJK Extension B (surrogate pair) at boundary: character stays intact.
    expect(truncateLine("AB𠮷CDEF", 7)).toBe("AB𠮷...");
  });

  it("resolves token totals and io breakdowns from valid numeric fields only", () => {
    expect(resolveTotalTokens()).toBeUndefined();
    expect(resolveTotalTokens(freshUsage(42))).toBe(42);
    expect(resolveTotalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
    expect(resolveTotalTokens({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined();

    expect(formatTokenUsageDisplay({ inputTokens: 10, outputTokens: 5 })).toBe(
      "tokens 15 (in 10 / out 5)",
    );
    expect(formatTokenUsageDisplay({ outputTokens: 5 })).toBe("tokens 5 (in 0 / out 5)");
    expect(formatTokenUsageDisplay({ inputTokens: Number.NaN, outputTokens: 0 })).toBe("");
  });

  it("formats io and context usage displays with fallback branches", () => {
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        ...freshUsage(2_100),
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300), context 2.1k");

    expect(formatTokenUsageDisplay(freshUsage(500))).toBe("tokens 500 context");
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        ...freshUsage(1_500),
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300)");
    expect(formatTokenUsageDisplay({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe("");
  });
});
