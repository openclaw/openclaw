import { expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

it.each([
  [
    "separates nested cache creation from uncached input",
    {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 60 },
    },
    { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: 110 },
  ],
  ["rejects empty usage", {}, undefined],
  [
    "keeps interrupted accounting without provisional counts or cost",
    {
      input: 20,
      output: 3,
      total: 23,
      cost: { total: 0.5 },
      usageReport: { state: "unavailable" },
    },
    { usageReport: { state: "unavailable" }, contextUsage: { state: "unavailable" } },
  ],
  [
    "normalizes llama.cpp completion timings",
    { timings: { prompt_n: 30_834, predicted_n: 34 } },
    { input: 30_834, output: 34, cacheRead: undefined, cacheWrite: undefined, total: undefined },
  ],
] as const)("%s", (_name, input, expected) => {
  expect(normalizeUsage(input)).toEqual(expected);
});

it("preserves recorded zero cost and 1h writes through normalization", () => {
  const raw = {
    input: 20,
    output: 10,
    cacheRead: 30,
    cacheWrite: 60,
    cacheWrite1h: 40,
    totalTokens: 120,
    cost: { total: 0, totalOrigin: "provider-billed" as const },
  };
  const normalized = normalizeUsage(structuredClone(raw));
  const { totalTokens, ...fields } = raw;
  expect(normalized).toEqual({ ...fields, total: totalTokens });
  expect(normalizeUsage(normalized)).toEqual(normalized);
});

it("retains a valid zero-cost-only fact", () => {
  const normalized = normalizeUsage({ cost: { total: 0 } });
  expect(normalized).toMatchObject({ cost: { total: 0 } });
  expect(normalizeUsage(normalized)).toEqual(normalized);
});

it("guards against empty/zero usage overwrites", () => {
  expect(hasNonzeroUsage(undefined)).toBe(false);
  expect(hasNonzeroUsage(null)).toBe(false);
  expect(hasNonzeroUsage({})).toBe(false);
  expect(hasNonzeroUsage({ input: 0, output: 0 })).toBe(false);
  expect(hasNonzeroUsage({ reasoningTokens: 1 })).toBe(true);
  expect(hasNonzeroUsage({ input: 1 })).toBe(true);
  expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  expect(
    hasNonzeroUsage({
      input: 12,
      output: 3,
      usageReport: { state: "unavailable" },
    }),
  ).toBe(false);
});

it("does not clamp derived session total tokens to the context window", () => {
  expect(
    deriveSessionTotalTokens({
      usage: { input: 27, cacheRead: 2_400_000, cacheWrite: 0, total: 2_402_300 },
      contextTokens: 200_000,
    }),
  ).toBe(2_400_027);
});
