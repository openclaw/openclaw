import { expect, it } from "vitest";
import {
  deriveContextPromptTokens,
  derivePromptTokens,
  deriveSessionTotalTokens,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
  type NormalizedUsage,
} from "./usage.js";

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

it("preserves only complete context snapshots", () => {
  const contextUsage = {
    state: "available",
    promptTokens: 148_874,
    totalTokens: 163_978,
  } as const;
  expect(normalizeUsage({ input: 12, contextUsage })).toMatchObject({ input: 12, contextUsage });
  expectNormalized(
    {
      input: 12,
      contextUsage: { state: "available", promptTokens: 163_978, totalTokens: 148_874 },
    },
    { input: 12 },
  );
});

it("handles OpenAI Responses input_tokens_details.cached_tokens field", () => {
  expectNormalized(
    {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 250,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 17 },
    },
    {
      input: 20,
      output: 30,
      cacheRead: 100,
      reasoningTokens: 17,
      total: 250,
    },
  );
});

it("normalizes zero Anthropic output reasoning tokens", () => {
  expect(
    normalizeUsage({
      input_tokens: 30,
      output_tokens: 40,
      output_tokens_details: { thinking_tokens: 0 },
    }),
  ).toMatchObject({ input: 30, output: 40, reasoningTokens: 0 });
});

it("clamps negative input to zero (pre-subtracted cached_tokens > prompt_tokens)", () => {
  expectNormalized(
    { input: -4900, output: 200, cacheRead: 5000 },
    { input: 0, output: 200, cacheRead: 5000 },
  );
});

it("returns undefined when no valid fields are provided", () => {
  expect(normalizeUsage(null)).toBeUndefined();
});
it("preserves reasoning token details", () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 18,
  };
  expect(toOpenAiChatCompletionsUsage(normalizeUsage(usage))).toEqual(usage);
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
it("prefers last-call usage over aggregate billing usage", () => {
  expect(
    deriveSessionTotalTokens({
      lastCallUsage: { input: 38_333, output: 66, cacheRead: 120_320, total: 158_719 },
      usage: {
        input: 497_720,
        output: 7_485,
        cacheRead: 1_323_520,
        total: 1_828_725,
      },
    }),
  ).toBe(158_653);
});

it("prefers the explicit context snapshot over aggregate billing buckets", () => {
  expect(
    deriveSessionTotalTokens({
      usage: {
        ...billingUsage,
        contextUsage: {
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        },
      },
    }),
  ).toBe(148_874);
});

it("does not store aggregate billing as session context when the snapshot is unavailable", () => {
  expect(
    deriveSessionTotalTokens({
      usage: { ...billingUsage, contextUsage: { state: "unavailable" } },
    }),
  ).toBeUndefined();
});

it("prefers promptTokens override over derived total", () => {
  const totalTokens = deriveSessionTotalTokens({
    usage: { input: 1000, cacheRead: 500, cacheWrite: 200 },
    contextTokens: 4000,
    promptTokens: 2500,
  });
  expect(totalTokens).toBe(2500);
});
