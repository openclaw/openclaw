import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import type { ProviderCatalogContext } from "../plugins/types.js";
import {
  defineSingleProviderPluginEntry,
  type SingleProviderPluginOptions,
} from "./provider-entry.js";

const demoPlugin = {
  id: "demo",
  name: "Demo Provider",
  description: "Demo provider plugin",
};

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const demoProvider = { label: "Demo", docsPath: "/providers/demo", catalog: {} };
type Provider = Extract<SingleProviderPluginOptions["provider"], { label: string }>;
function createEntry(
  provider: Partial<Provider> = {},
  overrides: Partial<SingleProviderPluginOptions> = {},
) {
  return defineSingleProviderPluginEntry({
    ...demoPlugin,
    manifest: createProviderManifest(),
    provider: { ...demoProvider, ...provider },
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
        choiceId: "demo-api-key",
        choiceLabel: "Demo API key",
        choiceHint: "Manifest-owned key",
        groupId: "demo-group",
        groupLabel: "Demo providers",
        groupHint: "Manifest-owned setup",
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

function createCatalogContext(
  config: ProviderCatalogContext["config"] = {},
): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

async function captureProviderEntry(params: {
  entry: ReturnType<typeof defineSingleProviderPluginEntry>;
  config?: ProviderCatalogContext["config"];
}) {
  const captured = capturePluginRegistration(params.entry);
  const provider = captured.providers[0];
  const modelCatalogProvider = captured.modelCatalogProviders[0];
  const catalog = await provider?.catalog?.run(createCatalogContext(params.config));
  const staticCatalog = await provider?.staticCatalog?.run(createCatalogContext(params.config));
  await modelCatalogProvider?.liveCatalog?.(createCatalogContext(params.config));
  await modelCatalogProvider?.staticCatalog?.(createCatalogContext(params.config));
  return { captured, provider, catalog, staticCatalog };
}

describe("defineSingleProviderPluginEntry", () => {
  it("keeps static catalog registration independent of live discovery", async () => {
    const liveCatalog = {
      provider: { baseUrl: "https://api.demo.test/v1", models: [createModel("live", "Live")] },
    };
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
      const entry = defineColdEntry({
        ...demoPlugin,
        manifest: createProviderManifest(),
        provider: {
          ...demoProvider,
          aliases: ["demo-alias"],
          catalog: { liveModelDiscovery: true },
        },
      });
      const provider = capturePluginRegistration(entry).providers[0];
      const context = createCatalogContext();
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

  it("gates generated catalogs by canonical and alias provider identities before auth", async () => {
    const entry = createEntry({ aliases: ["demo-alias"] });
    const provider = capturePluginRegistration(entry).providers[0];
    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "test-key" }));
    const context = { ...createCatalogContext(), resolveProviderApiKey };

    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["demo-alias"] }),
    ).resolves.toMatchObject({ provider: { apiKey: "test-key" } });

    resolveProviderApiKey.mockClear();
    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["other"] }),
    ).resolves.toBeNull();
    await expect(provider?.catalog?.run({ ...context, providerIds: [] })).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });

  it("accepts an alias scope for generated live model discovery", async () => {
    const entry = defineSingleProviderPluginEntry({
      ...demoPlugin,
      provider: {
        ...demoProvider,
        aliases: ["demo-alias"],
        catalog: {
          liveModelDiscovery: true,
          buildProvider: () => ({
            baseUrl: "not-a-url",
            api: "openai-completions",
            models: [],
          }),
        },
      },
    });
    const provider = capturePluginRegistration(entry).providers[0];

    await expect(
      provider?.catalog?.run({ ...createCatalogContext(), providerIds: ["demo-alias"] }),
    ).resolves.toMatchObject({ provider: { apiKey: "test-key" } });
  });

  it("creates registration-scoped provider state for provider factories", () => {
    let registrations = 0;
    const registrationApis: unknown[] = [];
    const entry = createEntry(
      {},
      {
        provider(api) {
          registrationApis.push(api);
          const registration = ++registrations;
          return {
            ...demoProvider,
            normalizeModelId: ({ modelId }) => `${modelId}:${registration}`,
          };
        },
      },
    );

    const firstRegistration = capturePluginRegistration(entry);
    const secondRegistration = capturePluginRegistration(entry);
    const first = firstRegistration.providers[0];
    const second = secondRegistration.providers[0];

    expect(first?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:1");
    expect(second?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:2");
    expect(registrationApis).toEqual([firstRegistration.api, secondRegistration.api]);
    expect(registrationApis[0]).not.toBe(registrationApis[1]);
    expect(registrations).toBe(2);
  });

  it("merges manifest onboarding metadata with provider-owned wizard model policies", () => {
    const manifest = createProviderManifest();
    const manifestChoice = {
      ...manifest.providerAuthChoices[0]!,
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
    const entry = createEntry(
      { manifestAuth: { wizard } },
      {
        manifest: { ...manifest, providerAuthChoices: [manifestChoice] },
      },
    );
    const {
      provider: _provider,
      method,
      optionKey: _optionKey,
      cliFlag: _cliFlag,
      ...metadata
    } = manifestChoice;

    const expectedWizard = structuredClone({ ...metadata, methodId: method, ...wizard });
    expect(capturePluginRegistration(entry).providers[0]?.auth[0]?.wizard).toMatchObject(
      expectedWizard,
    );
  });

  it("allows provider-owned manifest auth to disable the onboarding wizard", () => {
    const entry = createEntry({ manifestAuth: { wizard: false } });

    expect(capturePluginRegistration(entry).providers[0]?.auth[0]?.wizard).toBeUndefined();
  });

  it("honors explicit base URLs and provider-owned manifest auth overrides", async () => {
    const entry = createEntry({
      manifestAuth: { defaultModel: "demo/custom", preserveExistingPrimary: true },
      catalog: { allowExplicitBaseUrl: true },
    });

    const { provider, catalog, staticCatalog } = await captureProviderEntry({
      entry,
      config: configuredModels("demo", "https://override.demo.test/v1"),
    });

    expect(provider?.auth[0]?.starterModel).toBe("demo/custom");
    expect(catalog).toMatchObject({ provider: { baseUrl: "https://override.demo.test/v1" } });
    expect(staticCatalog).toMatchObject({ provider: { baseUrl: "https://api.demo.test/v1" } });
  });

  it("rejects manifest API-key metadata without its declared credential source", () => {
    const manifest = createProviderManifest();
    const entry = createEntry(
      {},
      {
        manifest: { ...manifest, setup: { providers: [] } },
      },
    );

    expect(() => capturePluginRegistration(entry)).toThrow(
      'Incomplete manifest API-key auth for provider "demo"',
    );
  });

  it("rejects a provider catalog without a manifest catalog or explicit builder", () => {
    const entry = createEntry({}, { manifest: undefined });

    expect(() => capturePluginRegistration(entry)).toThrow("Missing modelCatalog.providers.demo");
  });

  it("supports provider overrides, explicit env vars, and extra registration", async () => {
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
            wizard: {
              groupId: "shared-gateway",
              groupLabel: "Shared Gateway",
            },
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://gateway.test/v1",
            models: [createModel("router", "Router")],
          }),
          allowExplicitBaseUrl: true,
        },
        preserveLiteralProviderPrefix: true,
      },
      register(api) {
        api.registerWebSearchProvider({
          id: "gateway-search",
          label: "Gateway Search",
          hint: "search",
          envVars: [],
          placeholder: "",
          signupUrl: "https://example.com",
          credentialPath: "tools.web.search.gateway.apiKey",
          getCredentialValue: () => undefined,
          setCredentialValue() {},
          createTool: () => ({
            description: "search",
            parameters: {},
            execute: async () => ({}),
          }),
        });
      },
    });

    const { captured, provider, catalog } = await captureProviderEntry({
      entry,
      config: configuredModels("gateway", "https://override.test/v1", [
        createModel("router", "Router"),
      ]),
    });
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
});
