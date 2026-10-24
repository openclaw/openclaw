import { beforeAll, beforeEach, expect, it, vi } from "vitest";

type ResolveProviderInstallCatalogEntries =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries;
type ResolveManifestProviderAuthChoices =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoices;
type ResolvePluginProviders =
  typeof import("../plugins/providers.runtime.js").resolvePluginProvidersCore;

const { catalogChoices, manifestChoices, runtimeProviders } = vi.hoisted(() => ({
  catalogChoices: vi.fn<ResolveProviderInstallCatalogEntries>(() => []),
  manifestChoices: vi.fn<ResolveManifestProviderAuthChoices>(() => []),
  runtimeProviders: vi.fn<ResolvePluginProviders>(() => []),
}));
// mock-isolation: Keep install discovery limited to this test's synthetic catalog.
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: catalogChoices,
}));
// mock-isolation: Supply manifest choices without loading installed plugin metadata.
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: manifestChoices,
}));
// mock-isolation: Exercise setup flow selection without loading provider runtimes.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: runtimeProviders,
}));

let resolve: typeof import("./provider-flow.js").resolveProviderSetupFlowContributions;

const choice = (providerId: string, choiceLabel: string) => ({
  pluginId: providerId,
  providerId,
  methodId: "api-key",
  choiceId: `${providerId}-api-key`,
  choiceLabel,
});

function catalog(providerId: string, label: string, origin: "bundled" | "global", npmSpec: string) {
  return { ...choice(providerId, `${label} API key`), label, origin, install: { npmSpec } };
}

beforeAll(async () => {
  vi.resetModules();
  ({ resolveProviderSetupFlowContributions: resolve } = await import("./provider-flow.js"));
});

beforeEach(() => {
  for (const mock of [manifestChoices, catalogChoices, runtimeProviders]) {
    mock.mockReset().mockReturnValue([]);
  }
});

it("surfaces manifest provider auth choices before setup runtime loads", () => {
  manifestChoices.mockReturnValue([
    {
      ...choice("openai-compatible", "OpenAI-compatible API key"),
      choiceHint: "Use a compatible endpoint",
      assistantPriority: -5,
      assistantVisibility: "visible",
      groupId: "openai-compatible",
      groupLabel: "OpenAI-compatible",
      groupHint: "Self-hosted and compatible providers",
      onboardingScopes: ["text-inference"],
    },
  ]);

  expect(resolve()).toEqual([
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
  expect(manifestChoices).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ includeUntrustedWorkspacePlugins: false }),
  );
  expect(runtimeProviders).not.toHaveBeenCalled();
});

it("resolves text and media setup choices in one metadata-only pass", () => {
  manifestChoices.mockReturnValue([
    {
      ...choice("fal", "fal API key"),
      onboardingScopes: ["image-generation", "music-generation"],
    },
    choice("openai", "OpenAI API key"),
  ]);
  catalogChoices.mockReturnValue([
    {
      ...catalog("vydra", "Vydra", "bundled", "@openclaw/vydra-provider"),
      onboardingScopes: ["image-generation"],
    },
  ]);

  expect(resolve({ scope: "all" }).map(({ option }) => option.value)).toEqual(
    expect.arrayContaining(["fal-api-key", "openai-api-key", "vydra-api-key"]),
  );
  expect(manifestChoices).toHaveBeenCalledOnce();
  expect(catalogChoices).toHaveBeenCalledOnce();
  expect(runtimeProviders).not.toHaveBeenCalled();
});

it("hides install-catalog choices that cannot be enabled", () => {
  catalogChoices.mockReturnValue([
    catalog("blocked-provider", "Blocked Provider", "global", "@vendor/blocked-provider"),
  ]);

  expect(resolve({ config: { plugins: { enabled: false } } })).toStrictEqual([]);
});
