import { beforeAll, beforeEach, expect, it, vi } from "vitest";

type ResolveProviderInstallCatalogEntries =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries;
type ResolveManifestProviderAuthChoices =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoices;

const { catalogChoices, manifestChoices } = vi.hoisted(() => ({
  catalogChoices: vi.fn<ResolveProviderInstallCatalogEntries>(() => []),
  manifestChoices: vi.fn<ResolveManifestProviderAuthChoices>(() => []),
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
vi.mock("../plugins/providers.runtime.js", () => {
  throw new Error("Provider setup must not load provider runtimes");
});

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
  for (const mock of [manifestChoices, catalogChoices]) {
    mock.mockReset().mockReturnValue([]);
  }
});

it.each([undefined, "all"] as const)("resolves metadata-only setup choices (scope=%s)", (scope) => {
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
    { ...choice("fal", "fal API key"), onboardingScopes: ["image-generation", "music-generation"] },
  ]);
  catalogChoices.mockReturnValue([
    {
      ...catalog("vydra", "Vydra", "bundled", "@openclaw/vydra-provider"),
      onboardingScopes: ["image-generation"],
    },
  ]);
  const resolved = resolve({ scope });
  expect(resolved.filter(({ providerId }) => providerId === "openai-compatible")).toEqual([
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
  expect(resolved.map(({ option }) => option.value)).toEqual(
    scope
      ? ["fal-api-key", "openai-compatible-api-key", "vydra-api-key"]
      : ["openai-compatible-api-key"],
  );
});

it("hides install-catalog choices that cannot be enabled", () => {
  catalogChoices.mockReturnValue([
    catalog("blocked-provider", "Blocked Provider", "global", "@vendor/blocked-provider"),
  ]);

  expect(resolve({ config: { plugins: { enabled: false } } })).toStrictEqual([]);
});
