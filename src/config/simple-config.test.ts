import { describe, expect, it } from "vitest";
import { generateSimpleModelConfig, getConfigProfileDescriptions } from "./simple-config.js";

describe("generateSimpleModelConfig", () => {
  it("generates simple profile with just a primary model", () => {
    const result = generateSimpleModelConfig("simple", "anthropic/claude-opus-4-6");
    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.resilience).toBeUndefined();
  });

  it("trims whitespace from model IDs in simple profile", () => {
    const result = generateSimpleModelConfig("simple", "  anthropic/claude-opus-4-6  ");
    expect(result.model).toBe("anthropic/claude-opus-4-6");
  });

  it("generates resilient profile with primary and fallbacks", () => {
    const result = generateSimpleModelConfig("resilient", "anthropic/claude-opus-4-6", [
      "openrouter/deepseek/deepseek-v3.2",
      "groq/llama-3.3-70b-versatile",
    ]);

    expect(result.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openrouter/deepseek/deepseek-v3.2", "groq/llama-3.3-70b-versatile"],
    });

    expect(result.resilience).toBeDefined();
    expect(result.resilience?.autoFailover).toBe(true);
    expect(result.resilience?.sanitizeOnSwitch).toBe(true);
    expect(result.resilience?.gracefulDegradation).toBe(true);
    expect(result.resilience?.propagateChanges).toBe(true);
  });

  it("generates commercial profile with reasoning/coding/budget models", () => {
    const result = generateSimpleModelConfig("commercial", {
      reasoningModel: "anthropic/claude-opus-4-6",
      codingModel: "anthropic/claude-sonnet-4-5",
      budgetModel: "groq/llama-3.3-70b-versatile",
      monthlyBudget: 100,
    });

    expect(result.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["anthropic/claude-sonnet-4-5", "groq/llama-3.3-70b-versatile"],
    });

    expect(result.resilience?.autoFailover).toBe(true);
  });
});

describe("getConfigProfileDescriptions", () => {
  it("returns descriptions for all profiles", () => {
    const profiles = getConfigProfileDescriptions();
    expect(profiles).toHaveLength(3);
    expect(profiles.map((p) => p.profile)).toEqual(["simple", "resilient", "commercial"]);
    for (const p of profiles) {
      expect(p.description).toBeTruthy();
    }
  });
});
