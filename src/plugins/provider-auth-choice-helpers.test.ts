import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

describe("applyProviderAuthConfigPatch", () => {
  it("merges patched default model maps with existing models", () => {
    const base = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };
    const patch = {
      agents: {
        defaults: {
          models: {
            "google-gemini/gemini-2.5-pro": { alias: "Gemini Pro" },
            "openai/gpt-5.2": { alias: "GPT-5.2 Updated" },
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    // Should merge models, not replace
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": { alias: "GPT-5.2 Updated" },
      "google-gemini/gemini-2.5-pro": { alias: "Gemini Pro" },
    });
    expect(next.agents?.defaults?.model).toEqual(base.agents?.defaults?.model);
  });

  it("keeps normal recursive merges for unrelated provider auth patch fields", () => {
    const base = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "30m",
          },
        },
      },
    } satisfies OpenClawConfig;
    const patch = {
      agents: {
        defaults: {
          contextPruning: {
            ttl: "1h",
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    expect(next).toEqual({
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "1h",
          },
        },
      },
    });
  });
});
