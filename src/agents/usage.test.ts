import { expect, it } from "vitest";
import {
  deriveContextPromptTokens,
  derivePromptTokens,
  deriveSessionTotalTokens,
  makeZeroUsageSnapshot,
  hasNonzeroUsage,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
  type NormalizedUsage,
} from "./usage.js";

it("starts independent usage snapshots with zero counts and costs", () => {
  const first = makeZeroUsageSnapshot();
  first.input = 12;
  first.cost.total = 0.5;
  expect(makeZeroUsageSnapshot()).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

function expectNormalized(input: Parameters<typeof normalizeUsage>[0], expected: NormalizedUsage) {
  expect(normalizeUsage(input)).toEqual({
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    total: undefined,
    ...expected,
  });
}

const billingUsage = {
  input: 12,
  output: 15_104,
  cacheRead: 819_661,
  cacheWrite: 93_130,
  total: 927_907,
};

const contextUsage = {
  state: "available",
  promptTokens: 148_874,
  totalTokens: 163_978,
} as const;

it("preserves only complete context snapshots", () => {
  expect(normalizeUsage({ input: 12, contextUsage })).toMatchObject({ input: 12, contextUsage });
  expectNormalized(
    {
      input: 12,
      contextUsage: { state: "available", promptTokens: 163_978, totalTokens: 148_874 },
    },
    { input: 12 },
  );
});

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
  [
    "normalizes llama.cpp timings",
    { timings: { prompt_n: 30_834, predicted_n: 34 } },
    { input: 30_834, output: 34 },
  ],
  [
    "handles OpenAI Responses cache and reasoning details",
    {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 250,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 17 },
    },
    { input: 20, output: 30, cacheRead: 100, reasoningTokens: 17, total: 250 },
  ],
  [
    "normalizes zero Anthropic output reasoning tokens",
    {
      input_tokens: 30,
      output_tokens: 40,
      output_tokens_details: { thinking_tokens: 0 },
    },
    { input: 30, output: 40, reasoningTokens: 0 },
  ],
  [
    "clamps pre-subtracted negative input to zero",
    { input: -4900, output: 200, cacheRead: 5000 },
    { input: 0, output: 200, cacheRead: 5000 },
  ],
] satisfies Array<[string, Parameters<typeof normalizeUsage>[0], NormalizedUsage]>)(
  "%s",
  (_name, input, expected) => expectNormalized(input, expected),
);

it.each([null, {}])("returns undefined for empty usage %j", (raw) => {
  expect(normalizeUsage(raw)).toBeUndefined();
});
it("keeps interrupted accounting without provisional counts or cost", () => {
  expect(
    normalizeUsage({
      input: 20,
      output: 3,
      total: 23,
      cost: { total: 0.5 },
      usageReport: { state: "unavailable" },
    }),
  ).toEqual({ usageReport: { state: "unavailable" }, contextUsage: { state: "unavailable" } });
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
  for (const [input, expected] of [
    [undefined, false],
    [null, false],
    [{}, false],
    [{ input: 0, output: 0 }, false],
    [{ reasoningTokens: 1 }, true],
    [{ input: 1 }, true],
    [{ total: 1 }, true],
    [{ input: 12, output: 3, usageReport: { state: "unavailable" } }, false],
  ] satisfies [Parameters<typeof hasNonzeroUsage>[0], boolean][]) {
    expect(hasNonzeroUsage(input)).toBe(expected);
  }
});
it("preserves reasoning token details", () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 18,
  };
  expect(toOpenAiChatCompletionsUsage(normalizeUsage(structuredClone(usage)))).toEqual(usage);
});

it("returns zeros for undefined usage", () => {
  expect(toOpenAiChatCompletionsUsage(undefined)).toEqual({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

it("forwards cached_tokens via prompt_tokens_details when cache was hit", () => {
  expect(
    toOpenAiChatCompletionsUsage({
      input: 594,
      output: 79,
      cacheRead: 30848,
      cacheWrite: 0,
      total: 31521,
    }),
  ).toEqual({
    prompt_tokens: 31442,
    completion_tokens: 79,
    total_tokens: 31521,
    prompt_tokens_details: { cached_tokens: 30848 },
  });
});
it("returns undefined for empty usage", () => {
  expect(derivePromptTokens({})).toBeUndefined();
});
it("does not treat total-only usage as a prompt snapshot", () => {
  expect(deriveContextPromptTokens({ lastCallUsage: { input: 1_000, total: 1_200 } })).toBe(1_000);
  expect(deriveContextPromptTokens({ lastCallUsage: { total: 1_200 } })).toBeUndefined();
  expect(deriveContextPromptTokens({ lastCallUsage: { output: 200, total: 1_200 } })).toBe(1_000);
});
it.each([
  [
    "unclamped context exceeding its window",
    {
      usage: { input: 27, cacheRead: 2_400_000, cacheWrite: 0, total: 2_402_300 },
      contextTokens: 200_000,
    },
    2_400_027,
  ],
  [
    "last-call usage",
    {
      lastCallUsage: { input: 38_333, output: 66, cacheRead: 120_320, total: 158_719 },
      usage: { input: 497_720, output: 7_485, cacheRead: 1_323_520, total: 1_828_725 },
    },
    158_653,
  ],
  ["explicit context", { usage: { ...billingUsage, contextUsage } }, 148_874],
  [
    "unavailable context",
    { usage: { ...billingUsage, contextUsage: { state: "unavailable" } } },
    undefined,
  ],
  [
    "prompt override",
    {
      usage: { input: 1000, cacheRead: 500, cacheWrite: 200 },
      contextTokens: 4000,
      promptTokens: 2500,
    },
    2500,
  ],
] satisfies Array<[string, Parameters<typeof deriveSessionTotalTokens>[0], number | undefined]>)(
  "uses %s for session context",
  (_name, input, expected) => {
    expect(deriveSessionTotalTokens(input)).toBe(expected);
  },
);
