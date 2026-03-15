import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, ProviderRuntimeModel } from "./types.js";

const resolvePluginProvidersMock = vi.fn((_: unknown) => [] as ProviderPlugin[]);

vi.mock("./providers.js", () => ({
  resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
}));

import {
  prepareProviderExtraParams,
  resolveProviderCacheTtlEligibility,
  resolveProviderCapabilitiesWithPlugin,
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
  });

  it("dispatches runtime hooks for the matched provider", async () => {
    const prepareDynamicModel = vi.fn(async () => undefined);
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    resolvePluginProvidersMock.mockReturnValue([
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
        isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
      },
    ]);

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
      resolveProviderCacheTtlEligibility({
        provider: "demo",
        context: {
          provider: "demo",
          modelId: "anthropic/claude-sonnet-4-5",
        },
      }),
    ).toBe(true);

    expect(prepareDynamicModel).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeAuth).toHaveBeenCalledTimes(1);
  });
});
