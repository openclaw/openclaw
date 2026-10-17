// API-provider auth-choice tests cover built-in provider config, API keys, and provider plugin setup.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerAuthChoices from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";
import { prepareAuthChoice } from "./auth-choice.apply.js";

const resolvePluginProviders = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders>(),
);
const prepareAuthChoiceLoadedPluginProvider = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
  >(),
);
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-install-catalog.js").resolveDeprecatedProviderInstallCatalogEntry
  >(),
);

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
}));
vi.mock("../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider,
}));
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
}));

function createProvider(
  id: string,
  kind: ProviderPlugin["auth"][number]["kind"],
  choiceId: string,
  aliases?: string[],
): ProviderPlugin {
  return {
    id,
    label: id,
    aliases,
    auth: [
      {
        id: choiceId,
        label: choiceId,
        kind,
        wizard: { choiceId },
        run: vi.fn(async () => ({ profiles: [] })),
      },
    ],
  };
}

const workspaceDir = "/tmp/selected-agent-workspace";
const setupParams = {
  config: {},
  workspaceDir,
  prompter: {} as never,
  runtime: {} as never,
  setDefaultModel: false,
};

describe("normalizeApiKeyTokenProviderAuthChoice", () => {
  afterEach(() => {
    resolvePluginProviders.mockReset();
    prepareAuthChoiceLoadedPluginProvider.mockReset();
    resolveDeprecatedProviderInstallCatalogEntry.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    [createProvider("anthropic", "token", "setup-token"), "token", " anthropic ", "setup-token"],
    [
      createProvider("google", "api_key", "gemini-api-key", ["gemini"]),
      "apiKey",
      " GeMiNi ",
      "gemini-api-key",
    ],
    [createProvider("openai", "api_key", "openai-api-key"), "token", "openai", "token"],
  ] as const)("normalizes %j for %s/%s to %s", (provider, authChoice, tokenProvider, expected) => {
    resolvePluginProviders.mockReturnValue([provider]);
    expect(normalizeApiKeyTokenProviderAuthChoice({ authChoice, tokenProvider })).toBe(expected);
  });

  it.each([
    { authChoice: "apiKey", kind: "api_key" },
    { authChoice: "token", kind: "token" },
    { authChoice: "setup-token", kind: "token" },
  ] as const)(
    "resolves workspace-only $authChoice providers through interactive setup",
    async (choice) => {
      const provider = createProvider("workspace-provider", choice.kind, "workspace-provider-auth");
      const authProfiles = [
        {
          profileId: "workspace-provider:default",
          credential: {
            type: "api_key" as const,
            provider: provider.id,
            key: "fixture-workspace-key",
          },
        },
      ];
      resolvePluginProviders.mockImplementation((params) =>
        params?.workspaceDir === workspaceDir ? [provider] : [],
      );
      prepareAuthChoiceLoadedPluginProvider.mockImplementation(async (params, consume) =>
        consume(
          params.authChoice === "workspace-provider-auth"
            ? {
                config: params.config,
                authProfiles: structuredClone(authProfiles),
                persistAuthProfiles: async () => {},
              }
            : null,
        ),
      );

      const prepared = await prepareAuthChoice({
        ...setupParams,
        authChoice: choice.authChoice,
        opts: { tokenProvider: provider.id },
      });

      expect(prepared.authProfiles).toEqual(authProfiles);
    },
  );

  it.each(["manifest", "install catalog"] as const)(
    "resolves workspace-only deprecated auth choices from the %s",
    async (source) => {
      prepareAuthChoiceLoadedPluginProvider.mockImplementation(async (_params, consume) =>
        consume(null),
      );
      vi.spyOn(
        providerAuthChoices,
        "resolveManifestDeprecatedProviderAuthChoice",
      ).mockImplementation((_choice, params) =>
        source === "manifest" && params?.workspaceDir === workspaceDir
          ? ({ choiceId: "workspace-modern-auth" } as never)
          : undefined,
      );
      resolveDeprecatedProviderInstallCatalogEntry.mockImplementation((_choice, params) =>
        source === "install catalog" &&
        params?.workspaceDir === workspaceDir &&
        params.includeUntrustedWorkspacePlugins === false
          ? ({ choiceId: "workspace-modern-auth" } as never)
          : undefined,
      );

      await expect(
        prepareAuthChoice({
          ...setupParams,
          authChoice: "workspace-legacy-auth",
        }),
      ).rejects.toThrow('Use "workspace-modern-auth" instead');
    },
  );
});
