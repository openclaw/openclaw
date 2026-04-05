import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyPrimaryModel } from "./provider-model-primary.js";

describe("applyPrimaryModel", () => {
  it("preserves fallback settings when switching the default model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            fallbacksFromModels: true,
          },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;

    const next = applyPrimaryModel(cfg, "openai/gpt-5.4-mini");

    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4-mini",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
      fallbacksFromModels: true,
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.4": {},
      "openai/gpt-5.4-mini": {},
    });
  });
});
