import { describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveManifestProviderOnboardAuthFlags,
} from "./provider-auth-choices.js";

describe("provider auth choice manifest helpers", () => {
  it("flattens manifest auth choices", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          providerAuthChoices: [
            {
              provider: "openai",
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              onboardingScopes: ["text-inference"],
              optionKey: "openaiApiKey",
              cliFlag: "--openai-api-key",
              cliOption: "--openai-api-key <key>",
            },
          ],
        },
      ],
    });

    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      },
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("openai");
  });

  it("deduplicates flag metadata by option key + flag", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "moonshot",
          providerAuthChoices: [
            {
              provider: "moonshot",
              method: "api-key",
              choiceId: "moonshot-api-key",
              choiceLabel: "Kimi API key (.ai)",
              optionKey: "moonshotApiKey",
              cliFlag: "--moonshot-api-key",
              cliOption: "--moonshot-api-key <key>",
              cliDescription: "Moonshot API key",
            },
            {
              provider: "moonshot",
              method: "api-key-cn",
              choiceId: "moonshot-api-key-cn",
              choiceLabel: "Kimi API key (.cn)",
              optionKey: "moonshotApiKey",
              cliFlag: "--moonshot-api-key",
              cliOption: "--moonshot-api-key <key>",
              cliDescription: "Moonshot API key",
            },
          ],
        },
      ],
    });

    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "moonshotApiKey",
        authChoice: "moonshot-api-key",
        cliFlag: "--moonshot-api-key",
        cliOption: "--moonshot-api-key <key>",
        description: "Moonshot API key",
      },
    ]);
  });

  it("resolves deprecated auth-choice aliases through manifest metadata", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "minimax",
          providerAuthChoices: [
            {
              provider: "minimax",
              method: "api-global",
              choiceId: "minimax-global-api",
              deprecatedChoiceIds: ["minimax", "minimax-api"],
            },
          ],
        },
      ],
    });

    expect(resolveManifestDeprecatedProviderAuthChoice("minimax")?.choiceId).toBe(
      "minimax-global-api",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice("minimax-api")?.choiceId).toBe(
      "minimax-global-api",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice("openai")).toBeUndefined();
  });
});
