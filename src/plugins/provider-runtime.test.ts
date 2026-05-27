import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
  expectedAugmentedOpenaiCodexCatalogEntries,
} from "./provider-runtime.test-support.js";
import type { ProviderPlugin, ProviderRuntimeModel } from "./types.js";

type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type ResolveCatalogHookProviderPluginIds =
  typeof import("./providers.js").resolveCatalogHookProviderPluginIds;
type ResolveOwningPluginIdsForProvider =
  typeof import("./providers.js").resolveOwningPluginIdsForProvider;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>((_) => [] as ProviderPlugin[]);
const resolveCatalogHookProviderPluginIdsMock = vi.fn<ResolveCatalogHookProviderPluginIds>(
  (_) => [] as string[],
);
const resolveOwningPluginIdsForProviderMock = vi.fn<ResolveOwningPluginIdsForProvider>(
  (_) => undefined as string[] | undefined,
);

let augmentModelCatalogWithProviderPlugins: typeof import("./provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let buildProviderAuthDoctorHintWithPlugin: typeof import("./provider-runtime.js").buildProviderAuthDoctorHintWithPlugin;
let buildProviderMissingAuthMessageWithPlugin: typeof import("./provider-runtime.js").buildProviderMissingAuthMessageWithPlugin;
let buildProviderUnknownModelHintWithPlugin: typeof import("./provider-runtime.js").buildProviderUnknownModelHintWithPlugin;
let applyProviderNativeStreamingUsageCompatWithPlugin: typeof import("./provider-runtime.js").applyProviderNativeStreamingUsageCompatWithPlugin;
let formatProviderAuthProfileApiKeyWithPlugin: typeof import("./provider-runtime.js").formatProviderAuthProfileApiKeyWithPlugin;
let normalizeProviderConfigWithPlugin: typeof import("./provider-runtime.js").normalizeProviderConfigWithPlugin;
let normalizeProviderModelIdWithPlugin: typeof import("./provider-runtime.js").normalizeProviderModelIdWithPlugin;
let applyProviderResolvedModelCompatWithPlugins: typeof import("./provider-runtime.js").applyProviderResolvedModelCompatWithPlugins;
let applyProviderResolvedTransportWithPlugin: typeof import("./provider-runtime.js").applyProviderResolvedTransportWithPlugin;
let normalizeProviderTransportWithPlugin: typeof import("./provider-runtime.js").normalizeProviderTransportWithPlugin;
let prepareProviderExtraParams: typeof import("./provider-runtime.js").prepareProviderExtraParams;
let resolveProviderConfigApiKeyWithPlugin: typeof import("./provider-runtime.js").resolveProviderConfigApiKeyWithPlugin;
let resolveProviderStreamFn: typeof import("./provider-runtime.js").resolveProviderStreamFn;
let resolveProviderCacheTtlEligibility: typeof import("./provider-runtime.js").resolveProviderCacheTtlEligibility;
let resolveProviderBinaryThinking: typeof import("./provider-runtime.js").resolveProviderBinaryThinking;
let resolveProviderBuiltInModelSuppression: typeof import("./provider-runtime.js").resolveProviderBuiltInModelSuppression;
let createProviderEmbeddingProvider: typeof import("./provider-runtime.js").createProviderEmbeddingProvider;
let resolveProviderDefaultThinkingLevel: typeof import("./provider-runtime.js").resolveProviderDefaultThinkingLevel;
let resolveProviderModernModelRef: typeof import("./provider-runtime.js").resolveProviderModernModelRef;
let resolveProviderSyntheticAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderSyntheticAuthWithPlugin;
let resolveProviderUsageSnapshotWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageSnapshotWithPlugin;
let resolveProviderCapabilitiesWithPlugin: typeof import("./provider-runtime.js").resolveProviderCapabilitiesWithPlugin;
let resolveProviderUsageAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageAuthWithPlugin;
let resolveProviderXHighThinking: typeof import("./provider-runtime.js").resolveProviderXHighThinking;
let normalizeProviderResolvedModelWithPlugin: typeof import("./provider-runtime.js").normalizeProviderResolvedModelWithPlugin;
let prepareProviderDynamicModel: typeof import("./provider-runtime.js").prepareProviderDynamicModel;
let prepareProviderRuntimeAuth: typeof import("./provider-runtime.js").prepareProviderRuntimeAuth;
let resetProviderRuntimeHookCacheForTest: typeof import("./provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let refreshProviderOAuthCredentialWithPlugin: typeof import("./provider-runtime.js").refreshProviderOAuthCredentialWithPlugin;
let resolveProviderRuntimePlugin: typeof import("./provider-runtime.js").resolveProviderRuntimePlugin;
let runProviderDynamicModel: typeof import("./provider-runtime.js").runProviderDynamicModel;
let wrapProviderStreamFn: typeof import("./provider-runtime.js").wrapProviderStreamFn;

const MODEL: ProviderRuntimeModel = {
  id: "demo-model",
  name: "Demo Model",
  api: "openai-responses",
  provider: "demo",
  baseUrl: "https://api.example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
const DEMO_PROVIDER_ID = "demo";
const EMPTY_MODEL_REGISTRY = { find: () => null } as never;

function createOpenAiCatalogProviderPlugin(
  overrides: Partial<ProviderPlugin> = {},
): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    auth: [],
    suppressBuiltInModel: ({ provider, modelId }) =>
      (provider === "openai" || provider === "azure-openai-responses") &&
      modelId === "gpt-5.3-codex-spark"
        ? { suppress: true, errorMessage: "openai-codex/gpt-5.3-codex-spark" }
        : undefined,
    augmentModelCatalog: () => [
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ],
    ...overrides,
  };
}

function expectProviderRuntimePluginLoad(params: {
  provider: string;
  expectedPluginId?: string;
  expectedOnlyPluginIds?: string[];
}) {
  const plugin = resolveProviderRuntimePlugin({ provider: params.provider });

  expect(plugin?.id).toBe(params.expectedPluginId);
  expect(resolveOwningPluginIdsForProviderMock).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: params.provider,
    }),
  );
  if (params.expectedOnlyPluginIds) {
    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: params.expectedOnlyPluginIds,
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
      }),
    );
  } else {
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  }
}

function createDemoRuntimeContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    modelId: MODEL.id,
    ...overrides,
  };
}

function createDemoProviderContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    ...overrides,
  };
}

function createDemoResolvedModelContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string; model: ProviderRuntimeModel } {
  return createDemoRuntimeContext({
    model: MODEL,
    ...overrides,
  });
}

function expectCalledOnce(...mocks: Array<{ mock: { calls: unknown[] } }>) {
  for (const mockFn of mocks) {
    expect(mockFn).toHaveBeenCalledTimes(1);
  }
}

function expectResolvedValues(
  cases: ReadonlyArray<{
    actual: () => unknown;
    expected: unknown;
  }>,
) {
  cases.forEach(({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
}

async function expectResolvedMatches(
  cases: ReadonlyArray<{
    actual: () => Promise<unknown>;
    expected: Record<string, unknown>;
  }>,
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toMatchObject(expected);
    }),
  );
}

async function expectResolvedAsyncValues(
  cases: ReadonlyArray<{
    actual: () => Promise<unknown>;
    expected: unknown;
  }>,
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toEqual(expected);
    }),
  );
}

describe("provider-runtime", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./providers.js", () => ({
      resolveCatalogHookProviderPluginIds: (params: unknown) =>
        resolveCatalogHookProviderPluginIdsMock(params as never),
      resolveOwningPluginIdsForProvider: (params: unknown) =>
        resolveOwningPluginIdsForProviderMock(params as never),
    }));
    vi.doMock("./providers.runtime.js", () => ({
      resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
    }));
    ({
      augmentModelCatalogWithProviderPlugins,
      buildProviderAuthDoctorHintWithPlugin,
      buildProviderMissingAuthMessageWithPlugin,
      buildProviderUnknownModelHintWithPlugin,
      applyProviderNativeStreamingUsageCompatWithPlugin,
      applyProviderResolvedModelCompatWithPlugins,
      applyProviderResolvedTransportWithPlugin,
      formatProviderAuthProfileApiKeyWithPlugin,
      normalizeProviderConfigWithPlugin,
      normalizeProviderModelIdWithPlugin,
      normalizeProviderTransportWithPlugin,
      prepareProviderExtraParams,
      resolveProviderConfigApiKeyWithPlugin,
      resolveProviderStreamFn,
      resolveProviderCacheTtlEligibility,
      resolveProviderBinaryThinking,
      resolveProviderBuiltInModelSuppression,
      createProviderEmbeddingProvider,
      resolveProviderDefaultThinkingLevel,
      resolveProviderModernModelRef,
      resolveProviderSyntheticAuthWithPlugin,
      resolveProviderUsageSnapshotWithPlugin,
      resolveProviderCapabilitiesWithPlugin,
      resolveProviderUsageAuthWithPlugin,
      resolveProviderXHighThinking,
      normalizeProviderResolvedModelWithPlugin,
      prepareProviderDynamicModel,
      prepareProviderRuntimeAuth,
      resetProviderRuntimeHookCacheForTest,
      refreshProviderOAuthCredentialWithPlugin,
      resolveProviderRuntimePlugin,
      runProviderDynamicModel,
      wrapProviderStreamFn,
    } = await import("./provider-runtime.js"));
    resetProviderRuntimeHookCacheForTest();
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    resolveCatalogHookProviderPluginIdsMock.mockReset();
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue([]);
    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockReturnValue(undefined);
  });

  it("matches providers by alias for runtime hook lookup", () => {
    resolveOwningPluginIdsForProviderMock.mockReturnValue(["openrouter"]);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openrouter",
        label: "OpenRouter",
        aliases: ["Open Router"],
        auth: [],
      },
    ]);

    expectProviderRuntimePluginLoad({
      provider: "Open Router",
      expectedPluginId: "openrouter",
      expectedOnlyPluginIds: ["openrouter"],
    });
  });

  it("skips plugin loading when the provider has no owning plugin", () => {
    expectProviderRuntimePluginLoad({
      provider: "anthropic",
    });
  });

  it("can normalize model ids through provider aliases without changing ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        hookAliases: ["google-vertex"],
        auth: [],
        normalizeModelId: ({ modelId }) => modelId.replace("flash-lite", "flash-lite-preview"),
      },
    ]);

    expect(
      normalizeProviderModelIdWithPlugin({
        provider: "google-vertex",
        context: {
          provider: "google-vertex",
          modelId: "gemini-3.1-flash-lite",
        },
      }),
    ).toBe("gemini-3.1-flash-lite-preview");
    expect(resolveOwningPluginIdsForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google-vertex",
      }),
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("resolves config hooks through hook-only aliases without changing provider surfaces", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        hookAliases: ["google-antigravity"],
        auth: [],
        normalizeConfig: ({ providerConfig }) => ({
          ...providerConfig,
          baseUrl: "https://normalized.example.com/v1",
        }),
      },
    ]);

    expect(
      normalizeProviderConfigWithPlugin({
        provider: "google-antigravity",
        context: {
          provider: "google-antigravity",
          providerConfig: {
            baseUrl: "https://example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });
  });

  it("normalizes transport hooks without needing provider ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        auth: [],
        normalizeTransport: ({ api, baseUrl }) =>
          api === "google-generative-ai" && baseUrl === "https://generativelanguage.googleapis.com"
            ? {
                api,
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              }
            : undefined,
      },
    ]);

    expect(
      normalizeProviderTransportWithPlugin({
        provider: "google-paid",
        context: {
          provider: "google-paid",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("invalidates cached runtime providers when config mutates in place", () => {
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    } as { plugins: { entries: { demo: { enabled: boolean } } } };
    resolveOwningPluginIdsForProviderMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockImplementation((params) => {
      const runtimeConfig = params?.config as typeof config | undefined;
      const enabled = runtimeConfig?.plugins?.entries?.demo?.enabled === true;
      return enabled
        ? [
            {
              id: DEMO_PROVIDER_ID,
              label: "Demo",
              auth: [],
            },
          ]
        : [];
    });

    expect(
      resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      }),
    ).toBeUndefined();

    config.plugins.entries.demo.enabled = true;

    expect(
      resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      }),
    ).toMatchObject({
      id: DEMO_PROVIDER_ID,
    });
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches runtime hooks for the matched provider", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolveOwningPluginIdsForProviderMock.mockImplementation((params) => {
      if (params.provider === "demo") {
        return ["demo"];
      }
      if (params.provider === "openai") {
        return ["openai"];
      }
      return undefined;
    });
    const prepareDynamicModel = vi.fn(async () => undefined);
    const createStreamFn = vi.fn(() => vi.fn());
    const createEmbeddingProvider = vi.fn(async () => ({
      id: "demo",
      model: "demo-embed",
      embedQuery: async () => [1, 0, 0],
      embedBatch: async () => [[1, 0, 0]],
      client: { token: "embed-token" },
    }));
    const resolveSyntheticAuth = vi.fn(() => ({
      apiKey: "demo-local",
      source: "models.providers.demo (synthetic local key)",
      mode: "api-key" as const,
    }));
    const buildUnknownModelHint = vi.fn(
      ({ modelId }: { modelId: string }) => `Use demo setup for ${modelId}`,
    );
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    const refreshOAuth = vi.fn(async (cred) => ({
      ...cred,
      access: "refreshed-access-token",
    }));
    const resolveUsageAuth = vi.fn(async () => ({
      token: "usage-token",
      accountId: "usage-account",
    }));
    const fetchUsageSnapshot = vi.fn(async () => ({
      provider: "zai" as const,
      displayName: "Demo",
      windows: [{ label: "Day", usedPercent: 25 }],
    }));
    resolvePluginProvidersMock.mockImplementation((_params: unknown) => {
      return [
        {
          id: DEMO_PROVIDER_ID,
          label: "Demo",
          auth: [],
          normalizeConfig: ({ providerConfig }) => ({
            ...providerConfig,
            baseUrl: "https://normalized.example.com/v1",
          }),
          normalizeTransport: ({ api, baseUrl }) => ({
            api,
            baseUrl: baseUrl ? `${baseUrl}/normalized` : undefined,
          }),
          normalizeModelId: ({ modelId }) => modelId.replace("-legacy", ""),
          resolveDynamicModel: () => MODEL,
          prepareDynamicModel,
          applyNativeStreamingUsageCompat: ({ providerConfig }) => ({
            ...providerConfig,
            compat: { supportsUsageInStreaming: true },
          }),
          capabilities: {
            providerFamily: "openai",
          },
          prepareExtraParams: ({ extraParams }) => ({
            ...extraParams,
            transport: "auto",
          }),
          createStreamFn,
          wrapStreamFn: ({ streamFn, model }) => {
            expect(model).toMatchObject(MODEL);
            return streamFn;
          },
          createEmbeddingProvider,
          resolveSyntheticAuth,
          normalizeResolvedModel: ({ model }) => ({
            ...model,
            api: "openai-codex-responses",
          }),
          formatApiKey: (cred) =>
            cred.type === "oauth" ? JSON.stringify({ token: cred.access }) : "",
          refreshOAuth,
          resolveConfigApiKey: () => "DEMO_PROFILE",
          buildAuthDoctorHint: ({ provider, profileId }) =>
            provider === "demo" ? `Repair ${profileId}` : undefined,
          prepareRuntimeAuth,
          resolveUsageAuth,
          fetchUsageSnapshot,
          isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
          isBinaryThinking: () => true,
          supportsXHighThinking: ({ modelId }) => modelId === "gpt-5.4",
          resolveDefaultThinkingLevel: ({ reasoning }) => (reasoning ? "low" : "off"),
          isModernModelRef: ({ modelId }) => modelId.startsWith("gpt-5"),
        },
        {
          ...createOpenAiCatalogProviderPlugin({
            buildMissingAuthMessage: () =>
              'No API key found for provider "openai". Use openai-codex/gpt-5.4.',
            buildUnknownModelHint,
          }),
        } as ProviderPlugin,
      ];
    });

    expect(
      runProviderDynamicModel({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toMatchObject(MODEL);

    expect(
      normalizeProviderModelIdWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          modelId: "demo-model-legacy",
        },
      }),
    ).toBe("demo-model");

    expect(
      normalizeProviderTransportWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          api: "openai-completions",
          baseUrl: "https://demo.example.com",
        },
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://demo.example.com/normalized",
    });

    expect(
      normalizeProviderConfigWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            baseUrl: "https://demo.example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });

    expect(
      applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            baseUrl: "https://demo.example.com",
            api: "openai-completions",
            models: [],
          },
        },
      }),
    ).toMatchObject({
      compat: { supportsUsageInStreaming: true },
    });

    expect(
      resolveProviderConfigApiKeyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          env: { DEMO_PROFILE: "default" } as NodeJS.ProcessEnv,
        },
      }),
    ).toBe("DEMO_PROFILE");

    await prepareProviderDynamicModel({
      provider: DEMO_PROVIDER_ID,
      context: createDemoRuntimeContext({
        modelRegistry: EMPTY_MODEL_REGISTRY,
      }),
    });

    expect(
      resolveProviderCapabilitiesWithPlugin({
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      providerFamily: "openai",
    });

    expect(
      prepareProviderExtraParams({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          extraParams: { temperature: 0.3 },
        }),
      }),
    ).toMatchObject({
      temperature: 0.3,
      transport: "auto",
    });

    expect(
      resolveProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeTypeOf("function");

    await expectResolvedMatches([
      {
        actual: () =>
          createProviderEmbeddingProvider({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              config: {} as never,
              model: "demo-embed",
            }),
          }),
        expected: {
          id: "demo",
          model: "demo-embed",
          client: { token: "embed-token" },
        },
      },
      {
        actual: () =>
          prepareProviderRuntimeAuth({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoResolvedModelContext({
              env: process.env,
              apiKey: "source-token",
              authMode: "api-key",
            }),
          }),
        expected: {
          apiKey: "runtime-token",
          baseUrl: "https://runtime.example.com/v1",
          expiresAt: 123,
        },
      },
      {
        actual: () =>
          refreshProviderOAuthCredentialWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              type: "oauth",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            }),
          }),
        expected: {
          access: "refreshed-access-token",
        },
      },
      {
        actual: () =>
          resolveProviderUsageAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              resolveApiKeyFromConfigAndStore: () => "source-token",
              resolveOAuthToken: async () => null,
            }),
          }),
        expected: {
          token: "usage-token",
          accountId: "usage-account",
        },
      },
      {
        actual: () =>
          resolveProviderUsageSnapshotWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              token: "usage-token",
              timeoutMs: 5_000,
              fetchFn: vi.fn() as never,
            }),
          }),
        expected: {
          provider: "zai",
          windows: [{ label: "Day", usedPercent: 25 }],
        },
      },
    ]);

    expect(
      wrapProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          streamFn: vi.fn(),
        }),
      }),
    ).toBeTypeOf("function");

    expect(
      normalizeProviderResolvedModelWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toMatchObject({
      ...MODEL,
      api: "openai-codex-responses",
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeUndefined();

    expect(
      formatProviderAuthProfileApiKeyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          type: "oauth",
          provider: DEMO_PROVIDER_ID,
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    ).toBe('{"token":"oauth-access"}');

    await expectResolvedAsyncValues([
      {
        actual: () =>
          buildProviderAuthDoctorHintWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              profileId: "demo:default",
              store: { version: 1, profiles: {} },
            }),
          }),
        expected: "Repair demo:default",
      },
    ]);

    expectResolvedValues([
      {
        actual: () =>
          resolveProviderCacheTtlEligibility({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "anthropic/claude-sonnet-4-5",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderBinaryThinking({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "glm-5",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderXHighThinking({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderDefaultThinkingLevel({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
              reasoning: true,
            }),
          }),
        expected: "low",
      },
      {
        actual: () =>
          resolveProviderModernModelRef({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderSyntheticAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              providerConfig: {
                api: "openai-completions",
                baseUrl: "http://localhost:11434",
                models: [],
              },
            }),
          }),
        expected: {
          apiKey: "demo-local",
          source: "models.providers.demo (synthetic local key)",
          mode: "api-key",
        },
      },
      {
        actual: () =>
          buildProviderUnknownModelHintWithPlugin({
            provider: "openai",
            env: process.env,
            context: {
              env: process.env,
              provider: "openai",
              modelId: "gpt-5.4",
            },
          }),
        expected: "Use demo setup for gpt-5.4",
      },
    ]);

    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);

    expectCalledOnce(
      prepareDynamicModel,
      refreshOAuth,
      resolveSyntheticAuth,
      buildUnknownModelHint,
      prepareRuntimeAuth,
      resolveUsageAuth,
      fetchUsageSnapshot,
    );
  });

  it("merges compat contributions from owner and foreign provider plugins", () => {
    resolveOwningPluginIdsForProviderMock.mockReturnValue(["openrouter"]);
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          id: "openrouter",
          label: "OpenRouter",
          auth: [],
          contributeResolvedModelCompat: () => ({ supportsStrictMode: true }),
        },
        {
          id: "mistral",
          label: "Mistral",
          auth: [],
          contributeResolvedModelCompat: ({ modelId }) =>
            modelId.startsWith("mistralai/") ? { supportsStore: false } : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        provider: "openrouter",
        context: createDemoResolvedModelContext({
          provider: "openrouter",
          modelId: "mistralai/mistral-small-3.2-24b-instruct",
          model: {
            ...MODEL,
            provider: "openrouter",
            id: "mistralai/mistral-small-3.2-24b-instruct",
            compat: { supportsDeveloperRole: false },
          },
        }),
      }),
    ).toMatchObject({
      compat: {
        supportsDeveloperRole: false,
        supportsStrictMode: true,
        supportsStore: false,
      },
    });
  });

  it("applies foreign transport normalization for custom provider hosts", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === "custom-openai" &&
            api === "openai-completions" &&
            baseUrl === "https://api.openai.com/v1"
              ? { api: "openai-responses", baseUrl }
              : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedTransportWithPlugin({
        provider: "custom-openai",
        context: createDemoResolvedModelContext({
          provider: "custom-openai",
          modelId: "gpt-5.4",
          model: {
            ...MODEL,
            provider: "custom-openai",
            id: "gpt-5.4",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
        }),
      }),
    ).toMatchObject({
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("resolves bundled catalog hooks through provider plugins", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      const onlyPluginIds = params?.onlyPluginIds;
      if (!onlyPluginIds || !onlyPluginIds.includes("openai")) {
        return [];
      }
      return [createOpenAiCatalogProviderPlugin()];
    });

    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
    });

    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
            { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
            { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
            { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
          ],
        },
      }),
    ).resolves.toEqual(expectedAugmentedOpenaiCodexCatalogEntries);

    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
        activate: false,
        cache: false,
      }),
    );
  });
});
