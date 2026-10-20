import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildEffectiveManifestProviderConfig,
  buildManifestModelProviderConfig,
  buildManifestProviderCatalogFamily,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

describe("manifest model size projection", () => {
  const providerId = "local-models";
  const catalog: ModelCatalogProvider = {
    baseUrl: "http://127.0.0.1:1234/v1",
    api: "openai-completions",
    models: [
      {
        id: "compact-chat",
        contextWindow: 32_768,
        maxTokens: 8192,
        parameterCount: 4_000_000_000,
      },
    ],
  };

  it.each([
    ["raw manifest", () => buildManifestModelProviderConfig({ providerId, catalog }).models],
    [
      "effective manifest",
      () =>
        buildEffectiveManifestProviderConfig(
          normalizeModelCatalogProviderRows({
            provider: providerId,
            providerCatalog: catalog,
            source: "manifest",
          }),
        )?.models,
    ],
    [
      "family augmentation",
      () =>
        buildManifestProviderCatalogFamily({
          surfaces: [{ id: providerId, label: "Local models", catalog }],
        }).augmentModelCatalog(),
    ],
  ])("keeps total parameters through %s", (_name, project) => {
    expect(project()).toEqual([
      expect.objectContaining({ id: "compact-chat", parameterCount: 4_000_000_000 }),
    ]);
  });
});

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
    resolveProviderAuth: () => {
      throw new Error("Catalog must use API-key resolution");
    },
  };
}

describe("findCatalogTemplate", () => {
  it("keeps template priority and the first matching catalog entry", () => {
    const fallback = { provider: "demo", id: "fallback" };
    const preferred = { provider: " DEMO ", id: " Preferred " };
    const duplicate = { provider: "demo", id: "preferred" };
    const entries = [fallback, { provider: "other", id: "preferred" }, preferred, duplicate];

    expect(
      findCatalogTemplate({
        entries,
        providerId: "demo",
        templateIds: ["missing", "PREFERRED", "fallback"],
      }),
    ).toBe(preferred);
  });

  const sparseTemplateIds: string[] = [];
  sparseTemplateIds.length = 1;

  it.each([
    { name: "empty", templateIds: [], matches: false },
    { name: "sparse", templateIds: sparseTemplateIds, matches: false },
    { name: "missing", templateIds: ["missing"], matches: false },
    { name: "explicitly blank", templateIds: [""], matches: true },
  ])("preserves $name template selection", ({ templateIds, matches }) => {
    const entry = { provider: "demo", id: "" };
    expect(findCatalogTemplate({ entries: [entry], providerId: "demo", templateIds })).toBe(
      matches ? entry : undefined,
    );
  });
});

describe("buildSingleProviderApiKeyCatalog", () => {
  it.each([
    [
      "case-insensitive match",
      "Demo Provider",
      "demo-model",
      "demo provider",
      ["missing", "DEMO-MODEL"],
      true,
    ],
    ["no provider-ID aliasing", "z.ai", "glm-4.7", "z-ai", ["GLM-4.7"], false],
  ] as const)("%s", (_name, provider, id, providerId, templateIds, matches) => {
    const entry = { provider, id };
    expect(findCatalogTemplate({ entries: [entry], providerId, templateIds })).toEqual(
      matches ? entry : undefined,
    );
  });
  it.each([
    ["missing key", "test-provider", undefined, undefined, undefined],
    ["key injection", "test-provider", "secret-key", undefined, "https://default.example/v1"],
    [
      "explicit URL",
      "test-provider",
      "secret-key",
      " https://override.example/v1/ ",
      "https://override.example/v1/",
    ],
    [
      "exact provider ID",
      "z.ai",
      "secret-key",
      " https://api.z.ai/custom ",
      "https://api.z.ai/custom",
    ],
  ] as const)("%s", async (_name, providerId, apiKey, explicitUrl, expectedUrl) => {
    const ctx = createCatalogContext({
      apiKeys: { [providerId]: apiKey },
      config: explicitUrl
        ? { models: { providers: { [providerId]: { baseUrl: explicitUrl, models: [] } } } }
        : {},
    });
    const result = await buildSingleProviderApiKeyCatalog({
      ctx,
      providerId,
      allowExplicitBaseUrl: explicitUrl ? true : undefined,
      buildProvider: () =>
        createProviderConfig(
          providerId === "z.ai" ? { baseUrl: "https://default.example/zai" } : {},
        ),
    });
    expect(result).toEqual(
      apiKey ? { provider: createProviderConfig({ baseUrl: expectedUrl, apiKey }) } : null,
    );
  });
});
