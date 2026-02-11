import { describe, expect, it } from "vitest";
import {
  derivePromptTokens,
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
} from "./usage.js";

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
});

describe("derivePromptTokens", () => {
  it("returns only input tokens, ignoring cache tokens", () => {
    expect(derivePromptTokens({ input: 1_200, cacheRead: 300, cacheWrite: 50 })).toBe(1_200);
  });

  it("returns undefined when input is zero even if cache tokens exist", () => {
    expect(derivePromptTokens({ input: 0, cacheRead: 5_000, cacheWrite: 100 })).toBeUndefined();
  });

  it("returns undefined for undefined usage", () => {
    expect(derivePromptTokens(undefined)).toBeUndefined();
  });
});

describe("deriveSessionTotalTokens", () => {
  it("uses input tokens only — does not inflate with cache tokens (#13853)", () => {
    // With large cacheRead (common in Anthropic prompt caching), the old code
    // summed input+cacheRead+cacheWrite which exceeded the context window.
    // The fix uses only input tokens for context-window accounting.
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
    ).toBe(27);
  });

  it("returns input tokens when within context window", () => {
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
    ).toBe(1_200);
  });

  it("caps to context window when input exceeds it", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 250_000,
          total: 260_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(200_000);
  });

  it("falls back to usage.total when input is missing", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          total: 5_000,
        },
        contextTokens: 200_000,
      }),
    ).toBe(5_000);
  });

  it("falls back to input (0) when no prompt tokens and no total", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 0,
        },
        contextTokens: 200_000,
      }),
    ).toBeUndefined();
  });
});
