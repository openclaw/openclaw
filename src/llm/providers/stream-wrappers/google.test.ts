import { describe, expect, it } from "vitest";
import { sanitizeGoogleThinkingPayload } from "./google.js";

type ThinkingCase = {
  name: string;
  modelId: string;
  container?: "config" | "generationConfig";
  thinkingLevel?: Parameters<typeof sanitizeGoogleThinkingPayload>[0]["thinkingLevel"];
  initial: Record<string, unknown>;
  expected?: Record<string, unknown>;
};

describe("sanitizeGoogleThinkingPayload", () => {
  it.each<ThinkingCase>([
    {
      name: "removes the empty thinking config",
      modelId: "gemini-2.5-pro",
      initial: { thinkingBudget: 0 },
    },
    {
      name: "recognizes a provider-prefixed model",
      modelId: "google/gemini-2.5-pro-preview",
      initial: { thinkingBudget: 0 },
    },
    {
      name: "preserves other thinking config fields",
      modelId: "gemini-2.5-pro",
      initial: { thinkingBudget: 0, includeThoughts: true },
      expected: { includeThoughts: true },
    },
    {
      name: "normalizes native generationConfig",
      modelId: "gemini-2.5-pro",
      container: "generationConfig",
      initial: { thinkingBudget: 0, includeThoughts: true },
      expected: { includeThoughts: true },
    },
    {
      name: "allows disabled thinking for Flash",
      modelId: "gemini-2.5-flash",
      initial: { thinkingBudget: 0 },
      expected: { thinkingBudget: 0 },
    },
    {
      name: "preserves positive budgets",
      modelId: "gemini-2.5-pro",
      initial: { thinkingBudget: 1000 },
      expected: { thinkingBudget: 1000 },
    },
    {
      name: "rewrites Gemini 3 Pro budgets",
      modelId: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
      initial: { thinkingBudget: 2048, includeThoughts: true },
      expected: { includeThoughts: true, thinkingLevel: "HIGH" },
    },
    {
      name: "maps disabled Flash latest to minimal",
      modelId: "gemini-flash-latest",
      container: "generationConfig",
      thinkingLevel: "off",
      initial: { thinkingBudget: 0 },
      expected: { thinkingLevel: "MINIMAL" },
    },
    {
      name: "overrides negative Flash budgets with an explicit level",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
      initial: { thinkingBudget: -1, includeThoughts: true },
      expected: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
    {
      name: "uses provider defaults for Gemini 3 adaptive thinking",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "adaptive",
      initial: { thinkingBudget: 8192, includeThoughts: true },
      expected: { includeThoughts: true },
    },
    {
      name: "uses dynamic budgets for Gemini 2.5 adaptive thinking",
      modelId: "gemini-2.5-flash",
      thinkingLevel: "adaptive",
      initial: { thinkingBudget: 8192, includeThoughts: true },
      expected: { includeThoughts: true, thinkingBudget: -1 },
    },
  ])("$name", ({ modelId, container = "config", thinkingLevel, initial, expected }) => {
    const config: { thinkingConfig?: Record<string, unknown> } = { thinkingConfig: initial };
    sanitizeGoogleThinkingPayload({ payload: { [container]: config }, modelId, thinkingLevel });
    if (expected === undefined) {
      expect(config).not.toHaveProperty("thinkingConfig");
    } else {
      expect(config.thinkingConfig).toEqual(expected);
    }
  });
});
