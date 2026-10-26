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

type Raw = Parameters<typeof normalizeUsage>[0];
const contextUsage = { state: "available", promptTokens: 10, totalTokens: 12 } as const;
it("starts independent zero-count and zero-cost snapshots", () => {
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
it.each([
  [
    "nested cache creation",
    {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 60 },
    },
    { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: 110 },
  ],
  ["llama.cpp timings", { timings: { prompt_n: 30, predicted_n: 3 } }, { input: 30, output: 3 }],
  [
    "Responses cache and reasoning",
    {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
    { input: 2, output: 3, cacheRead: 10, reasoningTokens: 1, total: 25 },
  ],
  [
    "Anthropic zero reasoning",
    { input_tokens: 3, output_tokens: 4, output_tokens_details: { thinking_tokens: 0 } },
    { input: 3, output: 4, reasoningTokens: 0 },
  ],
  [
    "negative input",
    { input: -49, output: 2, cacheRead: 50 },
    { input: 0, output: 2, cacheRead: 50 },
  ],
  ["complete context", { input: 1, contextUsage }, { input: 1, contextUsage }],
  [
    "invalid context",
    { input: 1, contextUsage: { state: "available", promptTokens: 12, totalTokens: 10 } },
    { input: 1 },
  ],
] satisfies Array<[string, Raw, NormalizedUsage]>)("normalizes %s", (_name, raw, expected) => {
  expect(normalizeUsage(raw)).toEqual(expected);
});
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
it("preserves recorded zero cost and TTL writes through repeated normalization", () => {
  const raw = {
    input: 2,
    output: 1,
    cacheRead: 3,
    cacheWrite: 6,
    cacheWrite1h: 4,
    cacheWrite5m: 2,
    totalTokens: 12,
    cost: { total: 0, totalOrigin: "provider-billed" as const },
  };
  const normalized = normalizeUsage(structuredClone(raw));
  const { totalTokens, ...fields } = raw;
  expect(normalized).toEqual({ ...fields, total: totalTokens });
  expect(normalizeUsage(normalized)).toEqual(normalized);
});
it("retains a zero-cost-only fact", () => {
  const normalized = normalizeUsage({ cost: { total: 0 } });
  expect(normalized).toMatchObject({ cost: { total: 0 } });
  expect(normalizeUsage(normalized)).toEqual(normalized);
});
it.each([
  [undefined, false],
  [{}, false],
  [{ input: 0, output: 0 }, false],
  [{ reasoningTokens: 1 }, true],
  [{ input: 1 }, true],
  [{ total: 1 }, true],
  [{ input: 12, output: 3, usageReport: { state: "unavailable" } }, false],
] satisfies [Parameters<typeof hasNonzeroUsage>[0], boolean][])(
  "guards usage overwrite for %j",
  (input, expected) => expect(hasNonzeroUsage(input)).toBe(expected),
);
it.each([
  [undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
  [
    { input: 5, output: 1, cacheRead: 30, cacheWrite: 0, total: 36 },
    {
      prompt_tokens: 35,
      completion_tokens: 1,
      total_tokens: 36,
      prompt_tokens_details: { cached_tokens: 30 },
    },
  ],
] satisfies Array<[NormalizedUsage | undefined, ReturnType<typeof toOpenAiChatCompletionsUsage>]>)(
  "projects Chat Completions usage %j",
  (input, expected) => {
    expect(toOpenAiChatCompletionsUsage(input)).toEqual(expected);
  },
);
it("round-trips reasoning token details", () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 18,
  };
  expect(toOpenAiChatCompletionsUsage(normalizeUsage(structuredClone(usage)))).toEqual(usage);
});
it("does not derive a prompt from empty usage", () => {
  expect(derivePromptTokens({})).toBeUndefined();
});
it.each([
  [{ input: 1_000, total: 1_200 }, 1_000],
  [{ total: 1_200 }, undefined],
  [{ output: 200, total: 1_200 }, 1_000],
] satisfies Array<[NormalizedUsage, number | undefined]>)(
  "recovers only evidenced last-call prompt counts: %j",
  (lastCallUsage, expected) => {
    expect(deriveContextPromptTokens({ lastCallUsage })).toBe(expected);
  },
);
it.each([
  [
    "unclamped window",
    {
      usage: { input: 27, cacheRead: 2_400_000, cacheWrite: 0, total: 2_402_300 },
      contextTokens: 200_000,
    },
    2_400_027,
  ],
  [
    "last-call, not accumulated usage",
    {
      lastCallUsage: { input: 1, output: 3, cacheRead: 2, total: 6 },
      usage: { input: 10, output: 30, cacheRead: 20, total: 60 },
    },
    3,
  ],
  ["explicit context", { usage: { input: 1, contextUsage } }, 10],
  [
    "unavailable context",
    { usage: { input: 1, contextUsage: { state: "unavailable" } } },
    undefined,
  ],
  [
    "prompt override",
    { usage: { input: 10, cacheRead: 5, cacheWrite: 2 }, contextTokens: 40, promptTokens: 25 },
    25,
  ],
] satisfies Array<[string, Parameters<typeof deriveSessionTotalTokens>[0], number | undefined]>)(
  "uses %s for session context",
  (_name, input, expected) => expect(deriveSessionTotalTokens(input)).toBe(expected),
);
it.each(["cacheWrite1h", "cacheWrite5m"] as const)(
  "retains %s-only zero and positive usage",
  (bucket) => {
    for (const value of [0, 12]) {
      expect(normalizeUsage({ [bucket]: value })).toMatchObject({ [bucket]: value });
    }
  },
);
