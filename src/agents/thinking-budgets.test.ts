import { describe, expect, it } from "vitest";
import {
  checkThinkingBudgetConflict,
  DEFAULT_THINKING_BUDGETS,
  getSupportedModelsWithBudgets,
  resolveThinkingTokenBudget,
} from "./thinking-budgets.js";

describe("resolveThinkingTokenBudget", () => {
  it("returns 0 for 'off' thinking level", () => {
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "off")).toBe(0);
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "off")).toBe(0);
    expect(resolveThinkingTokenBudget("anthropic", "claude-opus-4-5", "off")).toBe(0);
  });

  it("resolves GPT-5.2 budgets correctly", () => {
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "minimal")).toBe(0);
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "low")).toBe(1_500);
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "medium")).toBe(4_000);
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "high")).toBe(10_000);
    expect(resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "xhigh")).toBe(25_000);
  });

  it("resolves Gemini 3 Pro budgets correctly", () => {
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "minimal")).toBe(500);
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "low")).toBe(2_000);
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "medium")).toBe(8_000);
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "high")).toBe(20_000);
    expect(resolveThinkingTokenBudget("google", "gemini-3-pro", "xhigh")).toBe(64_000);
  });

  it("resolves Gemini 3 Flash budgets correctly", () => {
    expect(resolveThinkingTokenBudget("google", "gemini-3-flash", "low")).toBe(1_500);
    expect(resolveThinkingTokenBudget("google", "gemini-3-flash", "medium")).toBe(5_000);
    expect(resolveThinkingTokenBudget("google", "gemini-3-flash", "high")).toBe(12_000);
    expect(resolveThinkingTokenBudget("google", "gemini-3-flash", "xhigh")).toBe(32_000);
  });

  it("resolves Claude SDK budgets correctly", () => {
    expect(resolveThinkingTokenBudget("anthropic", "claude-opus-4-5", "low")).toBe(10_000);
    expect(resolveThinkingTokenBudget("anthropic", "claude-opus-4-5", "medium")).toBe(25_000);
    expect(resolveThinkingTokenBudget("anthropic", "claude-opus-4-5", "high")).toBe(50_000);
    expect(resolveThinkingTokenBudget("anthropic", "claude-sonnet-4-5", "medium")).toBe(25_000);
  });

  it("resolves z.AI GLM-4.7 budgets correctly", () => {
    expect(resolveThinkingTokenBudget("zai", "glm-4.7", "low")).toBe(5_000);
    expect(resolveThinkingTokenBudget("zai", "glm-4.7", "medium")).toBe(15_000);
    expect(resolveThinkingTokenBudget("zai", "glm-4.7", "high")).toBe(30_000);
  });

  it("handles case-insensitive provider and model names", () => {
    expect(resolveThinkingTokenBudget("OPENAI-CODEX", "GPT-5.2", "medium")).toBe(4_000);
    expect(resolveThinkingTokenBudget("Google", "Gemini-3-Pro", "high")).toBe(20_000);
  });

  it("handles models with provider prefix in model name", () => {
    expect(resolveThinkingTokenBudget("", "openai-codex/gpt-5.2", "medium")).toBe(4_000);
    expect(resolveThinkingTokenBudget("", "google/gemini-3-pro", "high")).toBe(20_000);
  });

  it("returns fallback budget for unknown models", () => {
    expect(resolveThinkingTokenBudget("unknown", "model-x", "low")).toBe(2_000);
    expect(resolveThinkingTokenBudget("unknown", "model-x", "medium")).toBe(5_000);
    expect(resolveThinkingTokenBudget("unknown", "model-x", "high")).toBe(10_000);
    expect(resolveThinkingTokenBudget("unknown", "model-x", "xhigh")).toBe(20_000);
  });

  it("handles whitespace in provider and model names", () => {
    expect(resolveThinkingTokenBudget(" openai-codex ", " gpt-5.2 ", "medium")).toBe(4_000);
  });
});

describe("checkThinkingBudgetConflict", () => {
  it("detects no conflict when budget fits comfortably", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 4_000, // medium GPT-5.2
      contextWindow: 128_000,
      usedTokens: 50_000,
      reserveTokens: 20_000,
    });

    expect(result.hasConflict).toBe(false);
    expect(result.available).toBe(58_000); // 128k - 50k - 20k
    expect(result.needed).toBe(4_000);
    expect(result.recommendation).toBeUndefined();
  });

  it("detects conflict when budget exceeds available space", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 25_000, // xhigh GPT-5.2
      contextWindow: 128_000,
      usedTokens: 100_000,
      reserveTokens: 20_000,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(8_000); // 128k - 100k - 20k
    expect(result.needed).toBe(25_000);
    expect(result.recommendation).toBe("medium"); // Recommends medium (fits in 8k)
  });

  it("recommends 'high' when 20k+ tokens available", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 50_000, // Requested too much
      contextWindow: 200_000,
      usedTokens: 150_000,
      reserveTokens: 10_000,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(40_000);
    expect(result.recommendation).toBe("high"); // 20k fits in 40k available
  });

  it("recommends 'medium' when 8k-20k tokens available", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 25_000,
      contextWindow: 128_000,
      usedTokens: 108_000,
      reserveTokens: 10_000,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(10_000);
    expect(result.recommendation).toBe("medium"); // 8k fits in 10k available
  });

  it("recommends 'low' when 2k-8k tokens available", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 10_000,
      contextWindow: 128_000,
      usedTokens: 122_000,
      reserveTokens: 2_000,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(4_000);
    expect(result.recommendation).toBe("low"); // 2k fits in 4k available
  });

  it("recommends 'minimal' when 500-2k tokens available", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 5_000,
      contextWindow: 128_000,
      usedTokens: 126_000,
      reserveTokens: 1_000,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(1_000);
    expect(result.recommendation).toBe("minimal"); // 500 fits in 1k available
  });

  it("recommends 'off' when less than 500 tokens available", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 4_000,
      contextWindow: 128_000,
      usedTokens: 127_700,
      reserveTokens: 200,
    });

    expect(result.hasConflict).toBe(true);
    expect(result.available).toBe(100);
    expect(result.recommendation).toBe("off"); // Not enough space even for minimal
  });

  it("handles edge case of exactly fitting budget", () => {
    const result = checkThinkingBudgetConflict({
      thinkingBudget: 10_000,
      contextWindow: 128_000,
      usedTokens: 100_000,
      reserveTokens: 18_000,
    });

    expect(result.hasConflict).toBe(false);
    expect(result.available).toBe(10_000);
    expect(result.needed).toBe(10_000);
  });
});

describe("getSupportedModelsWithBudgets", () => {
  it("returns all supported models", () => {
    const models = getSupportedModelsWithBudgets();

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.key && m.budgets)).toBe(true);
  });

  it("includes GPT-5.2 variants", () => {
    const models = getSupportedModelsWithBudgets();
    const gpt52Keys = models.map((m) => m.key).filter((k) => k.includes("gpt-5.2"));

    expect(gpt52Keys).toContain("openai/gpt-5.2");
    expect(gpt52Keys).toContain("openai-codex/gpt-5.2");
    expect(gpt52Keys).toContain("openai-codex/gpt-5.2-codex");
  });

  it("includes Gemini 3 variants", () => {
    const models = getSupportedModelsWithBudgets();
    const geminiKeys = models.map((m) => m.key).filter((k) => k.includes("gemini-3"));

    expect(geminiKeys).toContain("google/gemini-3-pro");
    expect(geminiKeys).toContain("google/gemini-3-flash");
  });

  it("includes Claude variants", () => {
    const models = getSupportedModelsWithBudgets();
    const claudeKeys = models.map((m) => m.key).filter((k) => k.includes("claude"));

    expect(claudeKeys).toContain("anthropic/claude-opus-4-5");
    expect(claudeKeys).toContain("anthropic/claude-sonnet-4-5");
  });

  it("each budget has all thinking levels", () => {
    const models = getSupportedModelsWithBudgets();

    for (const model of models) {
      expect(model.budgets).toHaveProperty("off");
      expect(model.budgets).toHaveProperty("minimal");
      expect(model.budgets).toHaveProperty("low");
      expect(model.budgets).toHaveProperty("medium");
      expect(model.budgets).toHaveProperty("high");
      expect(model.budgets).toHaveProperty("xhigh");
    }
  });
});

describe("DEFAULT_THINKING_BUDGETS", () => {
  it("has consistent structure across all models", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];

    for (const budgets of Object.values(DEFAULT_THINKING_BUDGETS)) {
      for (const level of levels) {
        expect(budgets).toHaveProperty(level);
        expect(typeof budgets[level as keyof typeof budgets]).toBe("number");
        expect(budgets[level as keyof typeof budgets]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("has monotonically increasing budgets per model", () => {
    for (const budgets of Object.values(DEFAULT_THINKING_BUDGETS)) {
      expect(budgets.off).toBe(0);
      expect(budgets.minimal).toBeLessThanOrEqual(budgets.low);
      expect(budgets.low).toBeLessThan(budgets.medium);
      expect(budgets.medium).toBeLessThan(budgets.high);
      expect(budgets.high).toBeLessThanOrEqual(budgets.xhigh);
    }
  });

  it("GPT-5.2 has lower budgets than Gemini 3 Pro (more efficient)", () => {
    const gpt52 = DEFAULT_THINKING_BUDGETS["openai-codex/gpt-5.2"];
    const gemini3Pro = DEFAULT_THINKING_BUDGETS["google/gemini-3-pro"];

    expect(gpt52.medium).toBeLessThan(gemini3Pro.medium);
    expect(gpt52.high).toBeLessThan(gemini3Pro.high);
    expect(gpt52.xhigh).toBeLessThan(gemini3Pro.xhigh);
  });

  it("Gemini 3 Flash has lower budgets than Gemini 3 Pro", () => {
    const flash = DEFAULT_THINKING_BUDGETS["google/gemini-3-flash"];
    const pro = DEFAULT_THINKING_BUDGETS["google/gemini-3-pro"];

    expect(flash.low).toBeLessThan(pro.low);
    expect(flash.medium).toBeLessThan(pro.medium);
    expect(flash.high).toBeLessThan(pro.high);
    expect(flash.xhigh).toBeLessThan(pro.xhigh);
  });

  it("Claude SDK has highest budgets (extended thinking)", () => {
    const claude = DEFAULT_THINKING_BUDGETS["anthropic/claude-opus-4-5"];
    const gpt52 = DEFAULT_THINKING_BUDGETS["openai-codex/gpt-5.2"];

    expect(claude.low).toBeGreaterThan(gpt52.low);
    expect(claude.medium).toBeGreaterThan(gpt52.medium);
    expect(claude.high).toBeGreaterThan(gpt52.high);
  });
});
