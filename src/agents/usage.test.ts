import { describe, expect, it } from "vitest";
import {
  normalizeUsage,
  hasNonzeroUsage,
  derivePromptTokens,
  deriveSessionTotalTokens,
} from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes cache fields from provider response", () => {
    const usage = normalizeUsage({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
    });
    expect(usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
      total: undefined,
    });
  });

  it("normalizes cache fields from alternate naming", () => {
    const usage = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
    });
    expect(usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
      total: undefined,
    });
  });

  it("handles cache_read and cache_write naming variants", () => {
    const usage = normalizeUsage({
      input: 1000,
      cache_read: 1500,
      cache_write: 200,
    });
    expect(usage).toEqual({
      input: 1000,
      output: undefined,
      cacheRead: 1500,
      cacheWrite: 200,
      total: undefined,
    });
  });

  it("handles Moonshot/Kimi cached_tokens field", () => {
    // Moonshot v1 returns cached_tokens instead of cache_read_input_tokens
    const usage = normalizeUsage({
      prompt_tokens: 30,
      completion_tokens: 9,
      total_tokens: 39,
      cached_tokens: 19,
    });
    expect(usage).toEqual({
      input: 30,
      output: 9,
      cacheRead: 19,
      cacheWrite: undefined,
      total: 39,
    });
  });

  it("handles Kimi K2 prompt_tokens_details.cached_tokens field", () => {
    // Kimi K2 uses automatic prefix caching and returns cached_tokens in prompt_tokens_details
    const usage = normalizeUsage({
      prompt_tokens: 1113,
      completion_tokens: 5,
      total_tokens: 1118,
      prompt_tokens_details: { cached_tokens: 1024 },
    });
    expect(usage).toEqual({
      input: 1113,
      output: 5,
      cacheRead: 1024,
      cacheWrite: undefined,
      total: 1118,
    });
  });

  it("clamps negative input to zero (pre-subtracted cached_tokens > prompt_tokens)", () => {
    // pi-ai OpenAI-format providers subtract cached_tokens from prompt_tokens
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

  it("clamps negative prompt_tokens alias to zero", () => {
    const usage = normalizeUsage({
      prompt_tokens: -12,
      completion_tokens: 4,
    });
    expect(usage).toEqual({
      input: 0,
      output: 4,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it("returns undefined when no valid fields are provided", () => {
    const usage = normalizeUsage(null);
    expect(usage).toBeUndefined();
  });

  it("handles undefined input", () => {
    const usage = normalizeUsage(undefined);
    expect(usage).toBeUndefined();
  });
});

describe("hasNonzeroUsage", () => {
  it("returns true when cache read is nonzero", () => {
    const usage = { cacheRead: 100 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when cache write is nonzero", () => {
    const usage = { cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when both cache fields are nonzero", () => {
    const usage = { cacheRead: 100, cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns false when cache fields are zero", () => {
    const usage = { cacheRead: 0, cacheWrite: 0 };
    expect(hasNonzeroUsage(usage)).toBe(false);
  });

  it("returns false for undefined usage", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
  });
});

describe("derivePromptTokens", () => {
  it("includes cache tokens in prompt total", () => {
    const usage = {
      input: 1000,
      cacheRead: 500,
      cacheWrite: 200,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1700); // 1000 + 500 + 200
  });

  it("handles missing cache fields", () => {
    const usage = {
      input: 1000,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1000);
  });

  it("returns undefined for empty usage", () => {
    const promptTokens = derivePromptTokens({});
    expect(promptTokens).toBeUndefined();
  });
});

describe("deriveSessionTotalTokens", () => {
  it("includes cache tokens in total calculation", () => {
    const totalTokens = deriveSessionTotalTokens({
      usage: {
        input: 1000,
        cacheRead: 500,
        cacheWrite: 200,
      },
      contextTokens: 4000,
    });
    expect(totalTokens).toBe(1700); // 1000 + 500 + 200
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
