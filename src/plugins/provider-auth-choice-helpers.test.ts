import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

describe("applyProviderAuthConfigPatch", () => {
  it("merges patched default model maps instead of replacing them", () => {
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
            "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            "claude-cli/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    // Should merge, not replace - both providers' models should be present
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": {},
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
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
