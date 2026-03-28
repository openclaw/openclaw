import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://default.example/v1",
    models: [],
    ...overrides,
  };
}

function createCatalogContext(params: {
  config?: OpenClawConfig;
  apiKeys?: Record<string, string | undefined>;
}): ProviderCatalogContext {
  return {
    config: params.config ?? {},
    env: {},
    resolveProviderApiKey: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
    }),
    resolveProviderAuth: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
      mode: providerId && params.apiKeys?.[providerId] ? "api_key" : "none",
      source: providerId && params.apiKeys?.[providerId] ? "env" : "none",
    }),
  };
}

function expectSingleCatalogProvider(
  result: Awaited<ReturnType<typeof buildSingleProviderApiKeyCatalog>>,
  expected: ModelProviderConfig & { apiKey: string },
) {
  expect(result).toEqual({
    provider: expected,
  });
}

function expectPairedCatalogProviders(
  result: Awaited<ReturnType<typeof buildPairedProviderApiKeyCatalog>>,
  expected: Record<string, ModelProviderConfig & { apiKey: string }>,
) {
  expect(result).toEqual({
    providers: expected,
  });
}

function createSingleCatalogProvider(overrides: Partial<ModelProviderConfig> & { apiKey: string }) {
  return {
    provider: {
      ...createProviderConfig(overrides),
      apiKey: overrides.apiKey,
    },
  };
}

function createPairedCatalogProviders(
  apiKey: string,
  overrides: Partial<ModelProviderConfig> = {},
) {
  return {
    alpha: {
      ...createProviderConfig(overrides),
      apiKey,
    },
    beta: {
      ...createProviderConfig(overrides),
      apiKey,
    },
  };
}

async function expectSingleCatalogResult(params: {
  ctx: ProviderCatalogContext;
  allowExplicitBaseUrl?: boolean;
  buildProvider?: () => ModelProviderConfig;
  expected: Awaited<ReturnType<typeof buildSingleProviderApiKeyCatalog>>;
}) {
  const result = await buildSingleProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: "test-provider",
    buildProvider: params.buildProvider ?? (() => createProviderConfig()),
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
  });

  expect(result).toEqual(params.expected);
}

async function expectPairedCatalogResult(params: {
  ctx: ProviderCatalogContext;
  expected: Record<string, ModelProviderConfig & { apiKey: string }>;
}) {
  const result = await buildPairedProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: "test-provider",
    buildProviders: async () => ({
      alpha: createProviderConfig(),
      beta: createProviderConfig(),
    }),
  });

  expectPairedCatalogProviders(result, params.expected);
}

describe("buildSingleProviderApiKeyCatalog", () => {
  it.each([
    {
      name: "matches provider templates case-insensitively",
      entries: [
        { provider: "Demo Provider", id: "demo-model" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "demo provider",
      templateIds: ["missing", "DEMO-MODEL"],
      expected: { provider: "Demo Provider", id: "demo-model" },
    },
    {
      name: "matches provider templates across canonical provider aliases",
      entries: [
        { provider: "z.ai", id: "glm-4.7" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "z-ai",
      templateIds: ["GLM-4.7"],
      expected: { provider: "z.ai", id: "glm-4.7" },
    },
  ] as const)("$name", ({ entries, providerId, templateIds, expected }) => {
    const result = findCatalogTemplate({
      entries,
      providerId,
      templateIds,
    });

    expect(result).toEqual(expected);
  });
  it.each([
    ["returns null when api key is missing", createCatalogContext({}), undefined, null],
    [
      "adds api key to the built provider",
      createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      undefined,
      createSingleCatalogProvider({
        apiKey: "secret-key",
      }),
    ],
    [
      "prefers explicit base url when allowed",
      createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
        config: {
          models: {
            providers: {
              "test-provider": {
                baseUrl: " https://override.example/v1/ ",
                models: [],
              },
            },
          },
        },
      }),
      true,
      createSingleCatalogProvider({
        baseUrl: "https://override.example/v1/",
        apiKey: "secret-key",
      }),
    ],
  ] as const)("%s", async (_name, ctx, allowExplicitBaseUrl, expected) => {
    await expectSingleCatalogResult({
      ctx,
      allowExplicitBaseUrl,
      expected,
    });
  });

  it("matches explicit base url config across canonical provider aliases", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { zai: "secret-key" },
        config: {
          models: {
            providers: {
              "z.ai": {
                baseUrl: " https://api.z.ai/custom ",
                models: [],
              },
            },
          },
        },
      }),
      providerId: "z-ai",
      buildProvider: () => createProviderConfig({ baseUrl: "https://default.example/zai" }),
      allowExplicitBaseUrl: true,
    });

    expectSingleCatalogProvider(result, {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/custom",
      models: [],
      apiKey: "secret-key",
    });
  });

  it("adds api key to each paired provider", async () => {
    await expectPairedCatalogResult({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createPairedCatalogProviders("secret-key"),
    });
  });
});
