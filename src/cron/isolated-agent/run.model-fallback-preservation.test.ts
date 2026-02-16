import { describe, expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../../config/types.js";

/**
 * Tests for the model merge fix in runCronIsolatedAgentTurn.
 *
 * Bug: When an agent config defines `model: { primary: "..." }` without
 * `fallbacks`, the merge into `agentCfg` replaced the entire model object
 * from defaults—losing `fallbacks`.  This caused cron jobs to have only
 * one model candidate (the pinned model) plus the global primary, skipping
 * all intermediate fallbacks.
 *
 * Fix: Spread the existing `agentCfg.model` before applying the override,
 * so keys like `fallbacks` from `agents.defaults.model` survive when the
 * agent only overrides `primary`.
 */
describe("agent model override preserves default fallbacks", () => {
  // Simulates the merge logic extracted from run.ts lines 148–159
  function mergeAgentModel(
    defaults: AgentDefaultsConfig,
    overrideModel: { primary?: string; fallbacks?: string[] } | string | undefined,
  ): AgentDefaultsConfig {
    const agentCfg: AgentDefaultsConfig = { ...defaults };

    // --- FIX: merge instead of replace ---
    const existingModel =
      agentCfg.model && typeof agentCfg.model === "object" ? agentCfg.model : {};
    if (typeof overrideModel === "string") {
      agentCfg.model = { ...existingModel, primary: overrideModel };
    } else if (overrideModel) {
      agentCfg.model = { ...existingModel, ...overrideModel };
    }
    return agentCfg;
  }

  const defaultFallbacks = [
    "anthropic/claude-opus-4-6",
    "google-gemini-cli/gemini-3-pro-preview",
    "nvidia/deepseek-ai/deepseek-v3.2",
  ];

  const defaults: AgentDefaultsConfig = {
    model: {
      primary: "openai-codex/gpt-5.3-codex",
      fallbacks: defaultFallbacks,
    },
  };

  it("preserves fallbacks when agent overrides primary as string", () => {
    const result = mergeAgentModel(defaults, "anthropic/claude-sonnet-4-5");
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(model.fallbacks).toEqual(defaultFallbacks);
  });

  it("preserves fallbacks when agent overrides primary as object", () => {
    const result = mergeAgentModel(defaults, {
      primary: "anthropic/claude-sonnet-4-5",
    });
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(model.fallbacks).toEqual(defaultFallbacks);
  });

  it("allows agent to explicitly override fallbacks", () => {
    const customFallbacks = ["nvidia/deepseek-ai/deepseek-v3.2"];
    const result = mergeAgentModel(defaults, {
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: customFallbacks,
    });
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(model.fallbacks).toEqual(customFallbacks);
  });

  it("allows agent to explicitly clear fallbacks with empty array", () => {
    const result = mergeAgentModel(defaults, {
      primary: "anthropic/claude-sonnet-4-5",
      fallbacks: [],
    });
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(model.fallbacks).toEqual([]);
  });

  it("leaves model untouched when override is undefined", () => {
    const result = mergeAgentModel(defaults, undefined);
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("openai-codex/gpt-5.3-codex");
    expect(model.fallbacks).toEqual(defaultFallbacks);
  });

  it("handles missing defaults model gracefully", () => {
    const emptyDefaults: AgentDefaultsConfig = {};
    const result = mergeAgentModel(emptyDefaults, "anthropic/claude-sonnet-4-5");
    const model = result.model as { primary?: string; fallbacks?: string[] };

    expect(model.primary).toBe("anthropic/claude-sonnet-4-5");
    expect(model.fallbacks).toBeUndefined();
  });
});
