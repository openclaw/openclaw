import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, ProviderRuntimeModel } from "./types.js";

const resolvePluginProvidersMock = vi.fn((_: unknown) => [] as ProviderPlugin[]);

vi.mock("./providers.js", () => ({
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
}));

import {
  augmentModelCatalogWithProviderPlugins,
  buildProviderMissingAuthMessageWithPlugin,
  prepareProviderExtraParams,
  resolveProviderCacheTtlEligibility,
  resolveProviderBuiltInModelSuppression,
  resolveProviderUsageSnapshotWithPlugin,
  resolveProviderCapabilitiesWithPlugin,
  resolveProviderUsageAuthWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
  prepareProviderDynamicModel,
  prepareProviderRuntimeAuth,
  resolveProviderRuntimePlugin,
  runProviderDynamicModel,
  wrapProviderStreamFn,
} from "./provider-runtime.js";

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
  beforeEach(() => {
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
  });

  it("matches providers by alias for runtime hook lookup", () => {
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
    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Open Router",
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
      }),
    );
  });

  it("dispatches runtime hooks for the matched provider", async () => {
    const prepareDynamicModel = vi.fn(async () => undefined);
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
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
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      if (params?.onlyPluginIds?.includes("openai")) {
        return [
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
      }

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
          prepareRuntimeAuth,
          resolveUsageAuth,
          fetchUsageSnapshot,
          isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
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
      buildProviderMissingAuthMessageWithPlugin({
        provider: "openai",
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        },
      }),
    ).toContain("openai-codex/gpt-5.4");

    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "azure-openai-responses",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
      errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    });

    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
            { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
          ],
        },
      }),
    ).resolves.toEqual([
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ]);

    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
      }),
    );
    expect(prepareDynamicModel).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeAuth).toHaveBeenCalledTimes(1);
    expect(resolveUsageAuth).toHaveBeenCalledTimes(1);
    expect(fetchUsageSnapshot).toHaveBeenCalledTimes(1);
  });
});
