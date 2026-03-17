import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog.js";
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
});
