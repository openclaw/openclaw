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

  it("prefers manifest setup contributions over duplicate install-catalog entries", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
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
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "Catalog OpenAI API key",
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        providerId: "openai",
        option: {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI API key",
          },
        },
      },
    ]);
  });

  it("surfaces install-catalog choices without loading runtime setup options", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "vllm",
        providerId: "vllm",
        methodId: "server",
        choiceId: "vllm",
        choiceLabel: "vLLM",
        choiceHint: "Local server",
        groupId: "vllm",
        groupLabel: "vLLM",
        onboardingScopes: ["text-inference"],
        label: "vLLM",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/vllm",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        providerId: "vllm",
        option: {
          value: "vllm",
          label: "vLLM",
          hint: "Local server",
          group: {
            id: "vllm",
            label: "vLLM",
          },
        },
      },
    ]);
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledTimes(1);
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({ includeUntrustedWorkspacePlugins: false }),
    );
  });

  it("adds a fallback group when install-catalog entries omit group metadata", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
        label: "Demo Provider API key",
        origin: "global",
        install: {
          npmSpec: "@vendor/demo-provider",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        providerId: "demo-provider",
        option: {
          value: "demo-provider-api-key",
          label: "Demo Provider API key",
          group: {
            id: "demo-provider",
            label: "Demo Provider API key",
          },
        },
      },
    ]);
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

  it("hides install-catalog choices outside a configured plugin allowlist", () => {
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
          npmSpec: "@vendor/blocked-provider@1.2.3",
          expectedIntegrity: "sha512-blocked",
        },
      },
    ]);

    expect(
      resolveProviderSetupFlowContributions({
        config: {
          plugins: {
            allow: ["openai"],
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("keeps setup contributions on cold metadata when runtime discovery would fail", () => {
    resolvePluginProvidersCore.mockImplementation(() => {
      throw new Error("Runtime provider discovery must stay cold");
    });
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        providerId: "openai",
        option: {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI",
          },
        },
      },
    ]);
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });
});
