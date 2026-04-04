import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledPluginWebSearchProviders } from "./web-search-providers.js";

const listBundledWebSearchProvidersMock = vi.hoisted(() => vi.fn());
const resolveBundledWebSearchPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("./bundled-web-search.js", () => ({
  listBundledWebSearchProviders: listBundledWebSearchProvidersMock,
  resolveBundledWebSearchPluginIds: resolveBundledWebSearchPluginIdsMock,
}));

const EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_KEYS = [
  "brave:brave",
  "duckduckgo:duckduckgo",
  "exa:exa",
  "firecrawl:firecrawl",
  "google:gemini",
  "xai:grok",
  "moonshot:kimi",
  "perplexity:perplexity",
  "searxng:searxng",
  "tavily:tavily",
] as const;
const EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS = [
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "google",
  "xai",
  "moonshot",
  "perplexity",
  "searxng",
  "tavily",
] as const;
const EXPECTED_BUNDLED_WEB_SEARCH_CREDENTIAL_PATHS = [
  "plugins.entries.brave.config.webSearch.apiKey",
  "",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.firecrawl.config.webSearch.apiKey",
  "plugins.entries.google.config.webSearch.apiKey",
  "plugins.entries.xai.config.webSearch.apiKey",
  "plugins.entries.moonshot.config.webSearch.apiKey",
  "plugins.entries.perplexity.config.webSearch.apiKey",
  "plugins.entries.searxng.config.webSearch.baseUrl",
  "plugins.entries.tavily.config.webSearch.apiKey",
] as const;

function createBundledWebSearchProviderEntry(params: {
  pluginId: string;
  providerId: string;
  credentialPath: string;
  order: number;
  withApplySelectionConfig?: boolean;
  withResolveRuntimeMetadata?: boolean;
}): PluginWebSearchProviderEntry {
  return {
    pluginId: params.pluginId,
    id: params.providerId,
    label: params.providerId,
    hint: `${params.providerId} provider`,
    envVars: [],
    placeholder: `${params.providerId}-key`,
    signupUrl: `https://example.com/${params.providerId}`,
    autoDetectOrder: params.order,
    credentialPath: params.credentialPath,
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    ...(params.withApplySelectionConfig
      ? {
          applySelectionConfig: () => ({
            plugins: {
              entries: {
                [params.pluginId]: {
                  enabled: true,
                },
              },
            },
          }),
        }
      : {}),
    ...(params.withResolveRuntimeMetadata
      ? {
          resolveRuntimeMetadata: () => ({
            selectedProvider: params.providerId,
          }),
        }
      : {}),
    createTool: () => ({
      description: params.providerId,
      parameters: {},
      execute: async () => ({}),
    }),
  };
}

const BUNDLED_WEB_SEARCH_PROVIDERS: PluginWebSearchProviderEntry[] = [
  createBundledWebSearchProviderEntry({
    pluginId: "duckduckgo",
    providerId: "duckduckgo",
    credentialPath: "",
    order: 100,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "moonshot",
    providerId: "kimi",
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    order: 40,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "brave",
    providerId: "brave",
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    order: 10,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "perplexity",
    providerId: "perplexity",
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    order: 50,
    withResolveRuntimeMetadata: true,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "firecrawl",
    providerId: "firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    order: 60,
    withApplySelectionConfig: true,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "google",
    providerId: "gemini",
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    order: 20,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "tavily",
    providerId: "tavily",
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    order: 80,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "exa",
    providerId: "exa",
    credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
    order: 55,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "searxng",
    providerId: "searxng",
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    order: 70,
  }),
  createBundledWebSearchProviderEntry({
    pluginId: "xai",
    providerId: "grok",
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    order: 30,
  }),
];

function toProviderKeys(
  providers: ReturnType<typeof resolveBundledPluginWebSearchProviders>,
): string[] {
  return providers.map((provider) => `${provider.pluginId}:${provider.id}`);
}

function expectBundledWebSearchProviders(
  providers: ReturnType<typeof resolveBundledPluginWebSearchProviders>,
) {
  expect(toProviderKeys(providers)).toEqual(EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_KEYS);
  expect(providers.map((provider) => provider.credentialPath)).toEqual(
    EXPECTED_BUNDLED_WEB_SEARCH_CREDENTIAL_PATHS,
  );
}

function expectResolvedPluginIds(
  providers: ReturnType<typeof resolveBundledPluginWebSearchProviders>,
  expectedPluginIds: readonly string[],
) {
  expect(providers.map((provider) => provider.pluginId)).toEqual(expectedPluginIds);
}

function expectResolvedPluginIdsExcluding(
  providers: ReturnType<typeof resolveBundledPluginWebSearchProviders>,
  unexpectedPluginIds: readonly string[],
) {
  const pluginIds = providers.map((provider) => provider.pluginId);
  for (const pluginId of unexpectedPluginIds) {
    expect(pluginIds).not.toContain(pluginId);
  }
}

function expectBundledWebSearchResolution(params: {
  options?: Parameters<typeof resolveBundledPluginWebSearchProviders>[0];
  expectedProviders?: "full";
  expectedPluginIds?: readonly string[];
  excludedPluginIds?: readonly string[];
}) {
  const providers = resolveBundledPluginWebSearchProviders(params.options ?? {});

  if (params.expectedProviders === "full") {
    expectBundledWebSearchProviders(providers);
  }
  if (params.expectedPluginIds) {
    expectResolvedPluginIds(providers, params.expectedPluginIds);
  }
  if (params.excludedPluginIds) {
    expectResolvedPluginIdsExcluding(providers, params.excludedPluginIds);
  }
}

describe("resolveBundledPluginWebSearchProviders", () => {
  beforeEach(() => {
    listBundledWebSearchProvidersMock.mockReset();
    listBundledWebSearchProvidersMock.mockReturnValue(BUNDLED_WEB_SEARCH_PROVIDERS);
    resolveBundledWebSearchPluginIdsMock.mockReset();
    resolveBundledWebSearchPluginIdsMock.mockReturnValue([
      ...EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS,
    ]);
  });

  it.each([
    {
      title: "returns bundled providers in alphabetical order",
      options: {},
    },
    {
      title: "can resolve bundled providers through the manifest-scoped loader path",
      options: {
        bundledAllowlistCompat: true,
      },
    },
  ] as const)("$title", ({ options }) => {
    const providers = resolveBundledPluginWebSearchProviders(options);

    expectBundledWebSearchProviders(providers);
    expect(providers.find((provider) => provider.id === "firecrawl")?.applySelectionConfig).toEqual(
      expect.any(Function),
    );
    expect(
      providers.find((provider) => provider.id === "perplexity")?.resolveRuntimeMetadata,
    ).toEqual(expect.any(Function));
  });

  it.each([
    {
      title: "can augment restrictive allowlists for bundled compatibility",
      params: {
        config: {
          plugins: {
            allow: ["demo-other-plugin"],
          },
        },
        bundledAllowlistCompat: true,
      },
      expectedPluginIds: EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS,
    },
    {
      title: "does not return bundled providers excluded by a restrictive allowlist without compat",
      params: {
        config: {
          plugins: {
            allow: ["demo-other-plugin"],
          },
        },
      },
      expectedPluginIds: [],
    },
    {
      title: "returns no providers when plugins are globally disabled",
      params: {
        config: {
          plugins: {
            enabled: false,
          },
        },
      },
      expectedPluginIds: [],
    },
    {
      title: "can scope bundled resolution to one plugin id",
      params: {
        config: {
          tools: {
            web: {
              search: {
                provider: "gemini",
              },
            },
          },
        },
        bundledAllowlistCompat: true,
        onlyPluginIds: ["google"],
      },
      expectedPluginIds: ["google"],
    },
    {
      title: "preserves explicit bundled provider entry state",
      params: {
        config: {
          plugins: {
            entries: {
              perplexity: { enabled: false },
            },
          },
        },
      },
      excludedPluginIds: ["perplexity"],
    },
  ])("$title", ({ params, expectedPluginIds, excludedPluginIds }) => {
    expectBundledWebSearchResolution({
      options: params,
      expectedPluginIds,
      excludedPluginIds,
    });
  });
});
