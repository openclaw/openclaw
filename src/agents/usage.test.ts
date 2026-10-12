/**
 * Regression coverage for token usage normalization.
 * Verifies provider usage aliases, OpenAI-compatible output, and prompt-token derivation.
 */
import { describe, expect, it } from "vitest";
import {
  deriveContextPromptTokens,
  derivePromptTokens,
  deriveSessionTotalTokens,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
} from "./usage.js";

describe("normalizeUsage", () => {
  it("preserves only complete context snapshots", () => {
    expect(
      normalizeUsage({
        input: 12,
        contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
      }),
    ).toMatchObject({
      input: 12,
      contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    });
    expect(
      normalizeUsage({
        input: 12,
        contextUsage: { state: "available", promptTokens: 163_978, totalTokens: 148_874 },
      }),
    ).toEqual({
      input: 12,
      output: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("handles OpenAI Responses input_tokens_details.cached_tokens field", () => {
    const usage = normalizeUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 250,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 17 },
    });
    expect(usage).toEqual({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: undefined,
      reasoningTokens: 17,
      total: 250,
    });
  });

  it.each([{ provider: "Anthropic zero", details: { thinking_tokens: 0 }, expected: 0 }])(
    "normalizes $provider output reasoning token details",
    ({ details, expected }) => {
      expect(
        normalizeUsage({
          input_tokens: 30,
          output_tokens: 40,
          output_tokens_details: details,
        }),
      ).toMatchObject({ input: 30, output: 40, reasoningTokens: expected });
    },
  );

  it("clamps negative input to zero (pre-subtracted cached_tokens > prompt_tokens)", () => {
    // shared model runtime OpenAI-format providers subtract cached_tokens from prompt_tokens
    // upstream.  When cached_tokens exceeds prompt_tokens the result is negative.
    const usage = normalizeUsage({
      input: -4900,
      output: 200,
      cacheRead: 5000,
    });
    expect(usage).toEqual({
      input: 0,
      output: 200,
      cacheRead: 5000,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("returns undefined when no valid fields are provided", () => {
    const usage = normalizeUsage(null);
    expect(usage).toBeUndefined();
  });
});

describe("toOpenAiChatCompletionsUsage", () => {
  it("preserves reasoning token details", () => {
    const usage = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 18,
    });
    expect(toOpenAiChatCompletionsUsage(usage)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 18,
    });
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
});

describe("derivePromptTokens", () => {
  it("returns undefined for empty usage", () => {
    const promptTokens = derivePromptTokens({});
    expect(promptTokens).toBeUndefined();
  });
});

describe("deriveContextPromptTokens", () => {
  it("does not treat total-only usage as a prompt snapshot", () => {
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { input: 1_000, total: 1_200 },
      }),
    ).toBe(1_000);
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { total: 1_200 },
      }),
    ).toBeUndefined();
    expect(
      deriveContextPromptTokens({
        lastCallUsage: { output: 200, total: 1_200 },
      }),
    ).toBe(1_000);
  });
});

describe("deriveSessionTotalTokens", () => {
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
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 163_978,
          },
          total: 927_907,
        },
      }),
    ).toBe(148_874);
  });

  it("does not store aggregate billing as session context when the snapshot is unavailable", () => {
    expect(
      deriveSessionTotalTokens({
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          total: 927_907,
        },
      }),
    ).toBeUndefined();
  });

  it("prefers promptTokens override over derived total", () => {
    const totalTokens = deriveSessionTotalTokens({
      usage: {
        input: 1000,
        cacheRead: 500,
        cacheWrite: 200,
      },
      contextTokens: 4000,
      promptTokens: 2500, // Override
    });
    expect(totalTokens).toBe(2500);
  });
});
