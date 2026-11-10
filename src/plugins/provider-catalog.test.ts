import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildEffectiveManifestProviderConfig,
  buildManifestModelProviderConfig,
  buildManifestProviderCatalogFamily,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";

describe("manifest model projection", () => {
  const providerId = "family-host";
  const catalog: ModelCatalogProvider = {
    baseUrl: "http://127.0.0.1:1234/v1",
    api: "openai-completions",
    family: "meta",
    models: [
      {
        id: "compact-chat",
        contextWindow: 32_768,
        maxTokens: 8192,
        parameterCount: 4_000_000_000,
      },
      { id: "declares", family: "zai", contextWindow: 32_768, maxTokens: 8192 },
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
          surfaces: [{ id: providerId, label: "Family host", catalog }],
        }).augmentModelCatalog(),
    ],
  ])("keeps parameters and declared or inherited families through %s", (_name, project) => {
    expect(project()).toEqual([
      expect.objectContaining({
        id: "compact-chat",
        parameterCount: 4_000_000_000,
        family: "meta",
      }),
      expect.objectContaining({ id: "declares", family: "zai" }),
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

  it.each([
    { name: "empty", templateIds: [], matches: false },
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
  it("does not alias provider IDs when selecting templates", () => {
    expect(
      findCatalogTemplate({
        entries: [{ provider: "z.ai", id: "glm-4.7" }],
        providerId: "z-ai",
        templateIds: ["GLM-4.7"],
      }),
    ).toBeUndefined();
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
    const result = await buildSingleProviderApiKeyCatalog({
      ctx: {
        config: explicitUrl
          ? { models: { providers: { [providerId]: { baseUrl: explicitUrl, models: [] } } } }
          : {},
        env: {},
        resolveProviderApiKey: (id) => ({ apiKey: id === providerId ? apiKey : undefined }),
        resolveProviderAuth: () => {
          throw new Error("Catalog must use API-key resolution");
        },
      },
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
