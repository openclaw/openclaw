import { expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { capturePluginRegistration as captureRegistration } from "../plugins/captured-registration.js";
import type { ProviderCatalogContext } from "../plugins/types.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { buildCatalogModel } from "./provider-catalog.test-support.js";
import {
  defineSingleProviderPluginEntry,
  type SingleProviderPluginOptions,
} from "./provider-entry.js";

const demoPlugin = { id: "demo", name: "Demo Provider", description: "Demo provider plugin" };

function createModel(id: string, name: string): ModelDefinitionConfig {
  return buildCatalogModel(id, { name });
}

const demoProvider = { label: "Demo", docsPath: "/providers/demo", catalog: {} };
const wizardMetadata = {
  choiceId: "demo-api-key",
  choiceLabel: "Demo API key",
  choiceHint: "Manifest-owned key",
  groupId: "demo-group",
  groupLabel: "Demo providers",
  groupHint: "Manifest-owned setup",
};
type Provider = Extract<SingleProviderPluginOptions["provider"], { label: string }>;
function createEntry(
  provider: Partial<Provider> | SingleProviderPluginOptions["provider"] = {},
  overrides: Partial<SingleProviderPluginOptions> = {},
  define = defineSingleProviderPluginEntry,
) {
  return define({
    ...demoPlugin,
    manifest: createProviderManifest(),
    provider: typeof provider === "function" ? provider : { ...demoProvider, ...provider },
    ...overrides,
  });
}

function configuredModels(
  id: string,
  baseUrl: string,
  models = [createModel("configured", "Configured")],
) {
  return { models: { providers: { [id]: { baseUrl, models } } } };
}

function createProviderManifest() {
  return {
    setup: { providers: [{ id: "demo", envVars: ["DEMO_API_KEY"] }] },
    providerAuthChoices: [
      {
        provider: "demo",
        method: "api-key",
        ...wizardMetadata,
        optionKey: "demoApiKey",
        cliFlag: "--demo-api-key",
      },
    ],
    modelCatalog: {
      providers: {
        demo: {
          api: "openai-completions",
          baseUrl: "https://api.demo.test/v1",
          defaultModel: "default",
          models: [createModel("default", "Default")],
        },
      },
    },
  };
}

function catalogContext(config: ProviderCatalogContext["config"] = {}): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({ apiKey: "test-key", mode: "api_key", source: "env" }),
  };
}

async function captureProviderEntry(
  entry: ReturnType<typeof defineSingleProviderPluginEntry>,
  config?: ProviderCatalogContext["config"],
) {
  const captured = captureRegistration(entry);
  const provider = captured.providers[0];
  const modelCatalogProvider = captured.modelCatalogProviders[0];
  const catalog = await provider?.catalog?.run(catalogContext(config));
  const staticCatalog = await provider?.staticCatalog?.run(catalogContext(config));
  await modelCatalogProvider?.liveCatalog?.(catalogContext(config));
  await modelCatalogProvider?.staticCatalog?.(catalogContext(config));
  return { captured, provider, catalog, staticCatalog };
}

it("keeps static catalog registration independent of live discovery", async () => {
  const liveCatalog = { provider: { baseUrl: "https://live.test/v1", models: [] } };
  const buildLiveCatalog = vi.fn(async () => liveCatalog);
  const loadLiveCatalog = vi.fn(() => ({
    buildOpenAICompatibleProviderCatalog: buildLiveCatalog,
  }));
  vi.doMock("../agents/provider-attribution.js", () => {
    throw new Error("Static provider entry loaded transport policy");
  });
  vi.doMock("./provider-catalog-live-runtime.js", loadLiveCatalog);
  vi.resetModules();
  try {
    const { defineSingleProviderPluginEntry: defineColdEntry } =
      await import("./provider-entry.js");
    const entry = createEntry(
      {
        aliases: ["demo-alias"],
        catalog: { liveModelDiscovery: true },
      },
      {},
      defineColdEntry,
    );
    const provider = captureRegistration(entry).providers[0];
    const context = catalogContext();
    await expect(provider?.staticCatalog?.run(context)).resolves.toMatchObject({
      provider: { models: [createModel("default", "Default")] },
    });
    await expect(provider?.catalog?.run({ ...context, providerIds: [] })).resolves.toBeNull();
    expect(loadLiveCatalog).not.toHaveBeenCalled();

    const scopedContext = { ...context, providerIds: ["demo-alias"] };
    await expect(provider?.catalog?.run(scopedContext)).resolves.toBe(liveCatalog);
    expect(buildLiveCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ctx: scopedContext,
        providerId: "demo",
        providerAliases: ["demo-alias"],
      }),
    );
  } finally {
    vi.doUnmock("../agents/provider-attribution.js");
    vi.doUnmock("./provider-catalog-live-runtime.js");
    vi.resetModules();
  }
});

it.each([false, true])(
  "gates generated catalogs before auth (live discovery: %s)",
  async (live) => {
    const catalog: Provider["catalog"] = live
      ? {
          liveModelDiscovery: true,
          buildProvider: () => ({ baseUrl: "not-a-url", api: "openai-completions", models: [] }),
        }
      : {};
    const entry = createEntry(
      { aliases: ["demo-alias"], catalog },
      { manifest: live ? undefined : createProviderManifest() },
    );
    const provider = captureRegistration(entry).providers[0];
    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "test-key" }));
    const context = { ...catalogContext(), resolveProviderApiKey };

    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["demo-alias"] }),
    ).resolves.toMatchObject({ provider: { apiKey: "test-key" } });

    resolveProviderApiKey.mockClear();
    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["other"] }),
    ).resolves.toBeNull();
    await expect(provider?.catalog?.run({ ...context, providerIds: [] })).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  },
);

it("creates registration-scoped provider state for provider factories", () => {
  let registrations = 0;
  const registrationApis: unknown[] = [];
  const entry = createEntry((api) => {
    registrationApis.push(api);
    const registration = ++registrations;
    return {
      ...demoProvider,
      normalizeModelId: ({ modelId }) => `${modelId}:${registration}`,
    };
  });

  const firstRegistration = captureRegistration(entry);
  const secondRegistration = captureRegistration(entry);
  const [first, second] = [firstRegistration.providers[0], secondRegistration.providers[0]];

  expect(first?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:1");
  expect(second?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:2");
  expect(registrationApis).toEqual([firstRegistration.api, secondRegistration.api]);
  expect(registrationApis[0]).not.toBe(registrationApis[1]);
});

it("merges manifest onboarding metadata with provider-owned wizard model policies", () => {
  const manifest = createProviderManifest();
  const metadata = {
    ...wizardMetadata,
    assistantPriority: 4,
    modelTarget: "utility",
    assistantVisibility: "manual-only",
    onboardingFeatured: true,
    onboardingScopes: ["text-inference", "music-generation"],
  };
  const wizard = {
    modelAllowlist: { allowedKeys: ["demo/default"], loadCatalog: true },
    modelSelection: { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false },
  };
  Object.assign(manifest.providerAuthChoices[0]!, metadata);
  const entry = createEntry({ manifestAuth: { wizard } }, { manifest });
  const expectedWizard = structuredClone({ ...metadata, methodId: "api-key", ...wizard });
  expect(captureRegistration(entry).providers[0]?.auth[0]?.wizard).toMatchObject(expectedWizard);
});

it("allows provider-owned manifest auth to disable the onboarding wizard", () => {
  const entry = createEntry({ manifestAuth: { wizard: false } });

  expect(captureRegistration(entry).providers[0]?.auth[0]?.wizard).toBeUndefined();
});

it("honors explicit base URLs and provider-owned manifest auth overrides", async () => {
  const entry = createEntry({
    manifestAuth: { defaultModel: "demo/custom", preserveExistingPrimary: true },
    catalog: { allowExplicitBaseUrl: true },
  });

  const { provider, catalog, staticCatalog } = await captureProviderEntry(
    entry,
    configuredModels("demo", "https://override.demo.test/v1"),
  );

  expect(provider?.auth[0]?.starterModel).toBe("demo/custom");
  expect(catalog).toMatchObject({ provider: { baseUrl: "https://override.demo.test/v1" } });
  expect(staticCatalog).toMatchObject({ provider: { baseUrl: "https://api.demo.test/v1" } });
});

it.each([
  [undefined, "Missing modelCatalog.providers.demo"],
  [
    { ...createProviderManifest(), setup: { providers: [] } },
    'Incomplete manifest API-key auth for provider "demo"',
  ],
] as const)("rejects incomplete manifest: %s", (manifest, message) => {
  expect(() => captureRegistration(createEntry({}, { manifest }))).toThrow(message);
});

it("supports provider overrides, explicit env vars, and extra registration", async () => {
  const router = createModel("router", "Router");
  const entry = defineSingleProviderPluginEntry({
    id: "gateway-plugin",
    name: "Gateway Provider",
    description: "Gateway provider plugin",
    provider: {
      id: "gateway",
      label: "Gateway",
      aliases: ["gw"],
      docsPath: "/providers/gateway",
      envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
      auth: [
        {
          methodId: "api-key",
          label: "Gateway key",
          hint: "Primary key",
          optionKey: "gatewayKey",
          flagName: "--gateway-key",
          envVar: "GATEWAY_KEY",
          promptMessage: "Enter Gateway key",
          wizard: { groupId: "shared-gateway", groupLabel: "Shared Gateway" },
        },
      ],
      catalog: {
        buildProvider: () => ({
          api: "openai-completions",
          baseUrl: "https://gateway.test/v1",
          models: [router],
        }),
        allowExplicitBaseUrl: true,
      },
      preserveLiteralProviderPrefix: true,
    },
    register(api) {
      api.registerWebSearchProvider(
        createWebSearchTestProvider({
          pluginId: "gateway-plugin",
          id: "gateway-search",
          credentialPath: "tools.web.search.gateway.apiKey",
        }),
      );
    },
  });

  const { captured, provider, catalog } = await captureProviderEntry(
    entry,
    configuredModels("gateway", "https://override.test/v1", [router]),
  );
  expect(captured.providers).toHaveLength(1);
  expect(captured.modelCatalogProviders).toHaveLength(1);
  expect(captured.webSearchProviders).toHaveLength(1);

  expect(provider).toMatchObject({
    id: "gateway",
    label: "Gateway",
    aliases: ["gw"],
    envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
    preserveLiteralProviderPrefix: true,
  });
  expect(provider?.auth[0]?.wizard).toMatchObject({
    choiceId: "gateway-api-key",
    groupId: "shared-gateway",
    groupLabel: "Shared Gateway",
    groupHint: "Primary key",
  });

  expect(catalog).toEqual({
    provider: {
      api: "openai-completions",
      apiKey: "test-key",
      baseUrl: "https://override.test/v1",
      models: [createModel("router", "Router")],
    },
  });
});
