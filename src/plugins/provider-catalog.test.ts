import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

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
  };
}

describe("buildSingleProviderApiKeyCatalog", () => {
  it("matches provider templates case-insensitively", () => {
    const result = findCatalogTemplate({
      entries: [
        { provider: "OpenAI", id: "gpt-5.2" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "openai",
      templateIds: ["missing", "GPT-5.2"],
    });

    expect(result).toEqual({ provider: "OpenAI", id: "gpt-5.2" });
  });

  it("returns null when api key is missing", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({}),
      providerId: "test-provider",
      buildProvider: () => ({ api: "openai-completions", provider: "test-provider" }),
    });

    expect(result).toBeNull();
  });

  it("adds api key to the built provider", async () => {
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      providerId: "test-provider",
      buildProvider: async () => ({ api: "openai-completions", provider: "test-provider" }),
    });

    expect(result).toEqual({
      provider: {
        api: "openai-completions",
        provider: "test-provider",
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
              },
            },
          },
        },
      }),
      providerId: "test-provider",
      buildProvider: () => ({
        api: "openai-completions",
        provider: "test-provider",
        baseUrl: "https://default.example/v1",
      }),
      allowExplicitBaseUrl: true,
    });

    expect(result).toEqual({
      provider: {
        api: "openai-completions",
        provider: "test-provider",
        baseUrl: "https://override.example/v1/",
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
        alpha: { api: "openai-completions", provider: "alpha" },
        beta: { api: "openai-completions", provider: "beta" },
      }),
    });

    expect(result).toEqual({
      providers: {
        alpha: {
          api: "openai-completions",
          provider: "alpha",
          apiKey: "secret-key",
        },
        beta: {
          api: "openai-completions",
          provider: "beta",
          apiKey: "secret-key",
        },
      },
    });
  });
});
