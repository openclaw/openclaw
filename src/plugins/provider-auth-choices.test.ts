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

function createManifestPlugin(id: string, providerAuthChoices: Array<Record<string, unknown>>) {
  return {
    id,
    providerAuthChoices,
  };
}

function createProviderAuthChoice(overrides: Record<string, unknown>) {
  return overrides;
}

function setManifestPlugins(plugins: Array<Record<string, unknown>>) {
  loadPluginManifestRegistry.mockReturnValue({
    plugins,
  });
}

function expectAuthChoice(choiceId: string, providerId: string) {
  expect(resolveManifestProviderAuthChoice(choiceId)?.providerId).toBe(providerId);
}

function expectDeprecatedAuthChoice(choiceIds: string[], expectedChoiceId?: string) {
  for (const choiceId of choiceIds) {
    expect(resolveManifestDeprecatedProviderAuthChoice(choiceId)?.choiceId).toBe(expectedChoiceId);
  }
}

function setSingleManifestProviderAuthChoices(
  pluginId: string,
  providerAuthChoices: Array<Record<string, unknown>>,
) {
  setManifestPlugins([createManifestPlugin(pluginId, providerAuthChoices)]);
}

describe("provider auth choice manifest helpers", () => {
  it("flattens manifest auth choices", () => {
    setSingleManifestProviderAuthChoices("openai", [
      createProviderAuthChoice({
        provider: "openai",
        method: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      }),
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
    expectAuthChoice("openai-api-key", "openai");
  });

  it.each([
    {
      name: "deduplicates flag metadata by option key + flag",
      plugins: [
        createManifestPlugin("moonshot", [
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key",
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key-cn",
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
        ]),
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
        createManifestPlugin("minimax", [
          createProviderAuthChoice({
            provider: "minimax",
            method: "api-global",
            choiceId: "minimax-global-api",
            deprecatedChoiceIds: ["minimax", "minimax-api"],
          }),
        ]),
      ],
      run: () => {
        expectDeprecatedAuthChoice(["minimax", "minimax-api"], "minimax-global-api");
        expectDeprecatedAuthChoice(["openai"]);
      },
    },
  ])("$name", ({ plugins, run }) => {
    setManifestPlugins(plugins);
    run();
  });
});
