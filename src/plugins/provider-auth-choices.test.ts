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

function setManifestPlugins(plugins: Array<Record<string, unknown>>) {
  loadPluginManifestRegistry.mockReturnValue({
    plugins,
  });
}

describe("provider auth choice manifest helpers", () => {
  it("flattens manifest auth choices", () => {
    setManifestPlugins([
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
    ]);

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

  it.each([
    {
      name: "deduplicates flag metadata by option key + flag",
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
      run: () =>
        expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
          {
            optionKey: "moonshotApiKey",
            authChoice: "moonshot-api-key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            description: "Moonshot API key",
          },
        ]),
    },
    {
      name: "resolves deprecated auth-choice aliases through manifest metadata",
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
      run: () => {
        expect(resolveManifestDeprecatedProviderAuthChoice("minimax")?.choiceId).toBe(
          "minimax-global-api",
        );
        expect(resolveManifestDeprecatedProviderAuthChoice("minimax-api")?.choiceId).toBe(
          "minimax-global-api",
        );
        expect(resolveManifestDeprecatedProviderAuthChoice("openai")).toBeUndefined();
      },
    },
  ])("$name", ({ plugins, run }) => {
    setManifestPlugins(plugins);
    run();
  });
});
