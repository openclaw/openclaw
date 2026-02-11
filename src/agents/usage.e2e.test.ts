import { describe, expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes Anthropic-style snake_case usage", () => {
    const usage = normalizeUsage({
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      total_tokens: 1790,
    });
    expect(usage).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 50,
      cacheWrite: 200,
      total: 1790,
    });
  });

  it("normalizes OpenAI-style prompt/completion usage", () => {
    const usage = normalizeUsage({
      prompt_tokens: 987,
      completion_tokens: 123,
      total_tokens: 1110,
    });
    expect(usage).toEqual({
      input: 987,
      output: 123,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 1110,
    });
  });

  it("returns undefined for empty usage objects", () => {
    expect(normalizeUsage({})).toBeUndefined();
  });

  it("guards against empty/zero usage overwrites", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
    expect(hasNonzeroUsage(null)).toBe(false);
    expect(hasNonzeroUsage({})).toBe(false);
    expect(hasNonzeroUsage({ input: 0, output: 0 })).toBe(false);
    expect(hasNonzeroUsage({ input: 1 })).toBe(true);
    expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  });

  it("excludes cumulative cacheRead when sum exceeds context window (#13782)", () => {
    // When cacheRead is accumulated across many turns (e.g. 12 turns × 200k cached
    // system prompt = 2.4M), input + cacheRead + cacheWrite far exceeds the context
    // window. A single API call can never exceed contextWindow, so this indicates
    // cumulative data. The function should use input + cacheWrite instead.
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 27,
          cacheRead: 2_400_000,
          cacheWrite: 0,
          total: 2_402_300,
        },
        contextTokens: 200_000,
      }),
    ).toBe(27); // input + cacheWrite = 27, NOT clamped to 200k
  });

  it("still uses full prompt tokens when within context window", () => {
    // When prompt tokens are within the context window, use the full sum.
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 150_000,
          cacheRead: 48_000,
          cacheWrite: 0,
        },
        contextTokens: 200_000,
      }),
    ).toBe(198_000); // input + cacheRead within context window → use as-is
  });

  it("uses prompt tokens when within context window", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 2_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(1_550);
  });

  it("prefers explicit prompt token overrides", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 1_200,
          cacheRead: 300,
          cacheWrite: 50,
          total: 9_999,
        },
        promptTokens: 65_000,
        contextTokens: 200_000,
      }),
    ).toBe(65_000);
  });

  it("handles cumulative usage with nonzero cacheWrite", () => {
    // Cumulative: 5 turns, each reading 100k from cache, first turn wrote 100k
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 15_000,
          cacheRead: 500_000,
          cacheWrite: 100_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(115_000); // input + cacheWrite = 15k + 100k = 115k
  });

  it("uses input as floor when cacheWrite is also zero", () => {
    // Edge case: cumulative usage with zero cacheWrite (all turns cache-hit only)
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 5_000,
          cacheRead: 1_000_000,
          cacheWrite: 0,
        },
        contextTokens: 200_000,
      }),
    ).toBe(5_000); // input only, since cacheWrite is 0
  });
});
