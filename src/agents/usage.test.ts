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
