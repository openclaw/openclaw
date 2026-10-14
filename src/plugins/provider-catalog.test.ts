// Covers provider catalog entries derived from plugin metadata.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { buildSingleProviderApiKeyCatalog, findCatalogTemplate } from "./provider-catalog.js";
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

function expectCatalogTemplateMatch(params: {
  entries: Parameters<typeof findCatalogTemplate>[0]["entries"];
  providerId: string;
  templateIds: readonly string[];
  expected: ReturnType<typeof findCatalogTemplate>;
}) {
  expect(
    findCatalogTemplate({
      entries: params.entries,
      providerId: params.providerId,
      templateIds: params.templateIds,
    }),
  ).toEqual(params.expected);
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

function createSingleCatalogProvider(overrides: Partial<ModelProviderConfig> & { apiKey: string }) {
  return {
    provider: {
      ...createProviderConfig(overrides),
      apiKey: overrides.apiKey,
    },
  };
}

async function expectSingleCatalogResult(params: {
  ctx: ProviderCatalogContext;
  providerId?: string;
  allowExplicitBaseUrl?: boolean;
  buildProvider?: () => ModelProviderConfig;
  expected: Awaited<ReturnType<typeof buildSingleProviderApiKeyCatalog>>;
}) {
  const result = await buildSingleProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: params.providerId ?? "test-provider",
    buildProvider: params.buildProvider ?? (() => createProviderConfig()),
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
  });

  expect(result).toEqual(params.expected);
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
      name: "does not match provider templates across provider id variants",
      entries: [
        { provider: "z.ai", id: "glm-4.7" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "z-ai",
      templateIds: ["GLM-4.7"],
      expected: undefined,
    },
  ] as const)("$name", ({ entries, providerId, templateIds, expected }) => {
    expectCatalogTemplateMatch({
      entries,
      providerId,
      templateIds,
      expected,
    });
  });
  it.each([
    {
      name: "returns null when api key is missing",
      ctx: createCatalogContext({}),
      expected: null,
    },
    {
      name: "adds api key to the built provider",
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createSingleCatalogProvider({
        apiKey: "secret-key",
      }),
    },
    {
      name: "prefers explicit base url when allowed",
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
      allowExplicitBaseUrl: true,
      expected: createSingleCatalogProvider({
        baseUrl: "https://override.example/v1/",
        apiKey: "secret-key",
      }),
    },
    {
      name: "matches explicit base url config for exact provider ids",
      ctx: createCatalogContext({
        apiKeys: { "z.ai": "secret-key" },
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
      allowExplicitBaseUrl: true,
      expected: createSingleCatalogProvider({
        baseUrl: "https://api.z.ai/custom",
        apiKey: "secret-key",
      }),
      providerId: "z.ai",
      buildProvider: () => createProviderConfig({ baseUrl: "https://default.example/zai" }),
    },
  ] as const)(
    "$name",
    async ({ ctx, allowExplicitBaseUrl, expected, providerId, buildProvider }) => {
      await expectSingleCatalogResult({
        ctx,
        ...(providerId ? { providerId } : {}),
        allowExplicitBaseUrl,
        ...(buildProvider ? { buildProvider } : {}),
        expected,
      });
    },
  );
});
