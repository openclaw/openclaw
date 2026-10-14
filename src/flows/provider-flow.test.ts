// Provider flow tests cover provider setup prompts and config mutations.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ResolveProviderInstallCatalogEntries =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries;
type ResolveManifestProviderAuthChoices =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoices;
type ResolvePluginProviders =
  typeof import("../plugins/providers.runtime.js").resolvePluginProvidersCore;
type ResolveProviderSetupFlowContributions =
  typeof import("./provider-flow.js").resolveProviderSetupFlowContributions;

const resolveProviderInstallCatalogEntries = vi.hoisted(() =>
  vi.fn<ResolveProviderInstallCatalogEntries>(() => []),
);
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries,
}));

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoices>(() => []),
);
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

const resolvePluginProvidersCore = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore,
}));

let resolveProviderSetupFlowContributions: ResolveProviderSetupFlowContributions;

describe("provider flow install catalog contributions", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ resolveProviderSetupFlowContributions } = await import("./provider-flow.js"));
  });

  beforeEach(() => {
    resolveManifestProviderAuthChoices.mockReset();
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolveProviderInstallCatalogEntries.mockReset();
    resolveProviderInstallCatalogEntries.mockReturnValue([]);
    resolvePluginProvidersCore.mockReset();
    resolvePluginProvidersCore.mockReturnValue([]);
  });

  it("surfaces manifest provider auth choices before setup runtime loads", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai-compatible",
        providerId: "openai-compatible",
        methodId: "api-key",
        choiceId: "openai-compatible-api-key",
        choiceLabel: "OpenAI-compatible API key",
        choiceHint: "Use a compatible endpoint",
        assistantPriority: -5,
        assistantVisibility: "visible",
        groupId: "openai-compatible",
        groupLabel: "OpenAI-compatible",
        groupHint: "Self-hosted and compatible providers",
        onboardingScopes: ["text-inference"],
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        providerId: "openai-compatible",
        option: {
          value: "openai-compatible-api-key",
          label: "OpenAI-compatible API key",
          hint: "Use a compatible endpoint",
          assistantPriority: -5,
          assistantVisibility: "visible",
          group: {
            id: "openai-compatible",
            label: "OpenAI-compatible",
            hint: "Self-hosted and compatible providers",
          },
        },
      },
    ]);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledTimes(1);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ includeUntrustedWorkspacePlugins: false }),
    );
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("resolves text and media setup choices in one metadata-only pass", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "fal",
        providerId: "fal",
        methodId: "api-key",
        choiceId: "fal-api-key",
        choiceLabel: "fal API key",
        onboardingScopes: ["image-generation", "music-generation"],
      },
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
      },
    ]);
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "vydra",
        providerId: "vydra",
        methodId: "api-key",
        choiceId: "vydra-api-key",
        choiceLabel: "Vydra API key",
        onboardingScopes: ["image-generation"],
        label: "Vydra",
        origin: "bundled",
        install: { npmSpec: "@openclaw/vydra-provider" },
      },
    ]);

    expect(
      resolveProviderSetupFlowContributions({ scope: "all" }).map(({ option }) => option.value),
    ).toEqual(expect.arrayContaining(["fal-api-key", "openai-api-key", "vydra-api-key"]));
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledOnce();
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledOnce();
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("hides install-catalog choices that cannot be enabled", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "blocked-provider",
        providerId: "blocked-provider",
        methodId: "api-key",
        choiceId: "blocked-provider-api-key",
        choiceLabel: "Blocked Provider API key",
        label: "Blocked Provider",
        origin: "global",
        install: {
          npmSpec: "@vendor/blocked-provider",
        },
      },
    ]);

    expect(
      resolveProviderSetupFlowContributions({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });
});
