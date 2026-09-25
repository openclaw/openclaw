import { describe, expect, it, vi } from "vitest";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";

const LOCAL_PROVIDER_ID = "local-provider";

describe("applyAuthChoiceLoadedPluginProvider model migrations", () => {
  it("normalizes retired Google Gemini default models returned by auth methods", async () => {
    const method: ProviderAuthMethod = {
      id: "google",
      label: "Google",
      kind: "custom",
      run: async () => ({
        profiles: [],
        defaultModel: "google/gemini-3-pro-preview",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      providerId: "google",
      config: {},
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
  });

  it("replaces provider-owned default model maps during auth migrations", async () => {
    const method: ProviderAuthMethod = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: async () => ({
        profiles: [],
        configPatch: {
          agents: {
            defaults: {
              model: {
                primary: "claude-cli/claude-sonnet-4-6",
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
              },
              models: {
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        replaceDefaultModels: true,
        defaultModel: "claude-cli/claude-sonnet-4-6",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      providerId: LOCAL_PROVIDER_ID,
      config: {
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
      },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": {},
    });
  });
});
