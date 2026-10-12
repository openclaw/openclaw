/**
 * Focused usage-normalization tests for provider token payload variants.
 * Protects cache read/write and session total prompt-token calculations.
 */
import { describe, expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it.each(["cache_creation_input_tokens"])(
    "separates nested %s from uncached input",
    (writeField) => {
      const raw = {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 40, [writeField]: 60 },
      };
      expect(normalizeUsage(raw)).toEqual({
        input: 0,
        output: 10,
        cacheRead: 40,
        cacheWrite: 60,
        total: 110,
      });
    },
  );

  it.each([0])("preserves recorded cost %s and 1h writes through normalization", (total) => {
    const raw = {
      input: 20,
      output: 10,
      cacheRead: 30,
      cacheWrite: 60,
      cacheWrite1h: 40,
      totalTokens: 120,
      cost: { total, totalOrigin: "provider-billed" as const },
    };
    const normalized = normalizeUsage(raw);
    expect(normalized).toEqual({
      input: 20,
      output: 10,
      cacheRead: 30,
      cacheWrite: 60,
      cacheWrite1h: 40,
      total: 120,
      cost: { total, totalOrigin: "provider-billed" },
    });
    expect(normalizeUsage(normalized)).toEqual(normalized);
  });

  it.each([0])("retains a valid cost-only fact %s", (total) => {
    const normalized = normalizeUsage({ cost: { total } });
    expect(normalized).toMatchObject({ cost: { total } });
    expect(normalizeUsage(normalized)).toEqual(normalized);
  });

  it("normalizes llama.cpp completion timings", () => {
    const usage = normalizeUsage({
      timings: {
        prompt_n: 30_834,
        predicted_n: 34,
      },
    });
    expect(usage).toEqual({
      input: 30_834,
      output: 34,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
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
    expect(hasNonzeroUsage({ reasoningTokens: 1 })).toBe(true);
    expect(hasNonzeroUsage({ input: 1 })).toBe(true);
    expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  });

  it("does not clamp derived session total tokens to the context window", () => {
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
    ).toBe(2_400_027);
  });
});
