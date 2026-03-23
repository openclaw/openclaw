import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
} from "./provider-runtime.test-support.js";
import type { ProviderPlugin, ProviderRuntimeModel } from "./types.js";

type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type ResolveNonBundledProviderPluginIds =
  typeof import("./providers.js").resolveNonBundledProviderPluginIds;
type ResolveOwningPluginIdsForProvider =
  typeof import("./providers.js").resolveOwningPluginIdsForProvider;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>((_) => [] as ProviderPlugin[]);
const resolveNonBundledProviderPluginIdsMock = vi.fn<ResolveNonBundledProviderPluginIds>(
  (_) => [] as string[],
);
const resolveOwningPluginIdsForProviderMock = vi.fn<ResolveOwningPluginIdsForProvider>(
  (_) => undefined as string[] | undefined,
);

let augmentModelCatalogWithProviderPlugins: typeof import("./provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let buildProviderAuthDoctorHintWithPlugin: typeof import("./provider-runtime.js").buildProviderAuthDoctorHintWithPlugin;
let buildProviderMissingAuthMessageWithPlugin: typeof import("./provider-runtime.js").buildProviderMissingAuthMessageWithPlugin;
let formatProviderAuthProfileApiKeyWithPlugin: typeof import("./provider-runtime.js").formatProviderAuthProfileApiKeyWithPlugin;
let prepareProviderExtraParams: typeof import("./provider-runtime.js").prepareProviderExtraParams;
let resolveProviderCacheTtlEligibility: typeof import("./provider-runtime.js").resolveProviderCacheTtlEligibility;
let resolveProviderBinaryThinking: typeof import("./provider-runtime.js").resolveProviderBinaryThinking;
let resolveProviderBuiltInModelSuppression: typeof import("./provider-runtime.js").resolveProviderBuiltInModelSuppression;
let resolveProviderDefaultThinkingLevel: typeof import("./provider-runtime.js").resolveProviderDefaultThinkingLevel;
let resolveProviderModernModelRef: typeof import("./provider-runtime.js").resolveProviderModernModelRef;
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

describe("provider-runtime", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./providers.js", () => ({
      resolveNonBundledProviderPluginIds: (params: unknown) =>
        resolveNonBundledProviderPluginIdsMock(params as never),
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
      formatProviderAuthProfileApiKeyWithPlugin,
      prepareProviderExtraParams,
      resolveProviderCacheTtlEligibility,
      resolveProviderBinaryThinking,
      resolveProviderBuiltInModelSuppression,
      resolveProviderDefaultThinkingLevel,
      resolveProviderModernModelRef,
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
    resolveNonBundledProviderPluginIdsMock.mockReset();
    resolveNonBundledProviderPluginIdsMock.mockReturnValue([]);
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

    const plugin = resolveProviderRuntimePlugin({ provider: "Open Router" });

    expect(plugin?.id).toBe("openrouter");
    expect(resolveOwningPluginIdsForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Open Router",
      }),
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openrouter"],
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
      }),
    );
  });

  it("skips plugin loading when the provider has no owning plugin", () => {
    const plugin = resolveProviderRuntimePlugin({ provider: "anthropic" });

    expect(plugin).toBeUndefined();
    expect(resolveOwningPluginIdsForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
      }),
    );
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("dispatches runtime hooks for the matched provider", async () => {
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
          id: "demo",
          label: "Demo",
          auth: [],
          resolveDynamicModel: () => MODEL,
          prepareDynamicModel,
          capabilities: {
            providerFamily: "openai",
          },
          prepareExtraParams: ({ extraParams }) => ({
            ...extraParams,
            transport: "auto",
          }),
          wrapStreamFn: ({ streamFn }) => streamFn,
          normalizeResolvedModel: ({ model }) => ({
            ...model,
            api: "openai-codex-responses",
          }),
          formatApiKey: (cred) =>
            cred.type === "oauth" ? JSON.stringify({ token: cred.access }) : "",
          refreshOAuth,
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
          id: "openai",
          label: "OpenAI",
          auth: [],
          buildMissingAuthMessage: () =>
            'No API key found for provider "openai". Use openai-codex/gpt-5.4.',
          suppressBuiltInModel: ({ provider, modelId }) =>
            provider === "azure-openai-responses" && modelId === "gpt-5.3-codex-spark"
              ? { suppress: true, errorMessage: "openai-codex/gpt-5.3-codex-spark" }
              : undefined,
          augmentModelCatalog: () => [
            { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
            { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
            { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
            {
              provider: "openai-codex",
              id: "gpt-5.3-codex-spark",
              name: "gpt-5.3-codex-spark",
            },
          ],
        },
      ];
    });

    expect(
      runProviderDynamicModel({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: MODEL.id,
          modelRegistry: { find: () => null } as never,
        },
      }),
    ).toMatchObject(MODEL);

    await prepareProviderDynamicModel({
      provider: "demo",
      context: {
        provider: "demo",
        modelId: MODEL.id,
        modelRegistry: { find: () => null } as never,
      },
    });

    expect(
      resolveProviderCapabilitiesWithPlugin({
        provider: "demo",
      }),
    ).toMatchObject({
      providerFamily: "openai",
    });

    expect(
      prepareProviderExtraParams({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: MODEL.id,
          extraParams: { temperature: 0.3 },
        },
      }),
    ).toMatchObject({
      temperature: 0.3,
      transport: "auto",
    });

    expect(
      wrapProviderStreamFn({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: MODEL.id,
          streamFn: vi.fn(),
        },
      }),
    ).toBeTypeOf("function");

    expect(
      normalizeProviderResolvedModelWithPlugin({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: MODEL.id,
          model: MODEL,
        },
      }),
    ).toMatchObject({
      ...MODEL,
      api: "openai-codex-responses",
    });

    await expect(
      prepareProviderRuntimeAuth({
        provider: "demo",
        env: process.env,
        context: {
          env: process.env,
          provider: "demo",
          modelId: MODEL.id,
          model: MODEL,
          apiKey: "source-token",
          authMode: "api-key",
        },
      }),
    ).resolves.toMatchObject({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    });

    expect(
      formatProviderAuthProfileApiKeyWithPlugin({
        provider: "demo",
        context: {
          type: "oauth",
          provider: "demo",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    ).toBe('{"token":"oauth-access"}');

    await expect(
      refreshProviderOAuthCredentialWithPlugin({
        provider: "demo",
        context: {
          type: "oauth",
          provider: "demo",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    ).resolves.toMatchObject({
      access: "refreshed-access-token",
    });

    await expect(
      buildProviderAuthDoctorHintWithPlugin({
        provider: "demo",
        context: {
          provider: "demo",
          profileId: "demo:default",
          store: { version: 1, profiles: {} },
        },
      }),
    ).resolves.toBe("Repair demo:default");

    await expect(
      resolveProviderUsageAuthWithPlugin({
        provider: "demo",
        env: process.env,
        context: {
          config: {} as never,
          env: process.env,
          provider: "demo",
          resolveApiKeyFromConfigAndStore: () => "source-token",
          resolveOAuthToken: async () => null,
        },
      }),
    ).resolves.toMatchObject({
      token: "usage-token",
      accountId: "usage-account",
    });

    await expect(
      resolveProviderUsageSnapshotWithPlugin({
        provider: "demo",
        env: process.env,
        context: {
          config: {} as never,
          env: process.env,
          provider: "demo",
          token: "usage-token",
          timeoutMs: 5_000,
          fetchFn: vi.fn() as never,
        },
      }),
    ).resolves.toMatchObject({
      provider: "zai",
      windows: [{ label: "Day", usedPercent: 25 }],
    });

    expect(
      resolveProviderCacheTtlEligibility({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "anthropic/claude-sonnet-4-5",
        },
      }),
    ).toBe(true);

    expect(
      resolveProviderBinaryThinking({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "glm-5",
        },
      }),
    ).toBe(true);

    expect(
      resolveProviderXHighThinking({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "gpt-5.4",
        },
      }),
    ).toBe(true);

    expect(
      resolveProviderDefaultThinkingLevel({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "gpt-5.4",
          reasoning: true,
        },
      }),
    ).toBe("low");

    expect(
      resolveProviderModernModelRef({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "gpt-5.4",
        },
      }),
    ).toBe(true);

    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);

    expect(prepareDynamicModel).toHaveBeenCalledTimes(1);
    expect(refreshOAuth).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeAuth).toHaveBeenCalledTimes(1);
    expect(resolveUsageAuth).toHaveBeenCalledTimes(1);
    expect(fetchUsageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("resolves bundled catalog hooks without loading provider plugins", async () => {
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
            { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
          ],
        },
      }),
    ).resolves.toEqual([
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
    ]);

    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });
});
