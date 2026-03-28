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

describe("buildSingleProviderApiKeyCatalog", () => {
  it("matches provider templates case-insensitively", () => {
    const result = findCatalogTemplate({
      entries: [
        { provider: "Demo Provider", id: "demo-model" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "demo provider",
      templateIds: ["missing", "DEMO-MODEL"],
    });

    expect(result).toEqual({ provider: "Demo Provider", id: "demo-model" });
  });

  it("matches provider templates across canonical provider aliases", () => {
    const result = findCatalogTemplate({
      entries: [
        { provider: "z.ai", id: "glm-4.7" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "z-ai",
      templateIds: ["GLM-4.7"],
    });

    expect(result).toEqual({ provider: "z.ai", id: "glm-4.7" });
  });

  it("returns null when api key is missing", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({}),
      providerId: "test-provider",
      buildProvider: () => createProviderConfig(),
    });

    expect(result).toBeNull();
  });

  it("adds api key to the built provider", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      providerId: "test-provider",
      buildProvider: async () => createProviderConfig(),
    });

    expect(result).toEqual({
      provider: {
        api: "openai-completions",
        baseUrl: "https://default.example/v1",
        models: [],
        apiKey: "secret-key",
      },
    });
  });

  it("prefers explicit base url when allowed", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({
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
      providerId: "test-provider",
      buildProvider: () => createProviderConfig(),
      allowExplicitBaseUrl: true,
    });

    expect(result).toEqual({
      provider: {
        api: "openai-completions",
        baseUrl: "https://override.example/v1/",
        models: [],
        apiKey: "secret-key",
      },
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

    expect(result).toEqual({
      provider: {
        api: "openai-completions",
        baseUrl: "https://api.z.ai/custom",
        models: [],
        apiKey: "secret-key",
      },
    });
  });

  it("adds api key to each paired provider", async () => {
    const result = await buildPairedProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      providerId: "test-provider",
      buildProviders: async () => ({
        alpha: createProviderConfig(),
        beta: createProviderConfig(),
      }),
    });

    expect(result).toEqual({
      providers: {
        alpha: {
          api: "openai-completions",
          baseUrl: "https://default.example/v1",
          models: [],
          apiKey: "secret-key",
        },
        beta: {
          api: "openai-completions",
          baseUrl: "https://default.example/v1",
          models: [],
          apiKey: "secret-key",
        },
      },
    });
  });
});
