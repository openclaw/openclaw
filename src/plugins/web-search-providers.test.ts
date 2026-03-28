import { describe, expect, it } from "vitest";
import { resolveBundledPluginWebSearchProviders } from "./web-search-providers.js";

const WEB_SEARCH_PROVIDER_TEST_TIMEOUT_MS = 300_000;
const EXPECTED_BUNDLED_WEB_SEARCH_PROVIDER_KEYS = [
  "brave:brave",
  "duckduckgo:duckduckgo",
  "exa:exa",
  "firecrawl:firecrawl",
  "google:gemini",
  "xai:grok",
  "moonshot:kimi",
  "perplexity:perplexity",
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
  "plugins.entries.tavily.config.webSearch.apiKey",
] as const;

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

describe("resolveBundledPluginWebSearchProviders", () => {
  it(
    "returns bundled providers in alphabetical order",
    { timeout: WEB_SEARCH_PROVIDER_TEST_TIMEOUT_MS },
    () => {
      const providers = resolveBundledPluginWebSearchProviders({});

      expectBundledWebSearchProviders(providers);
      expect(
        providers.find((provider) => provider.id === "firecrawl")?.applySelectionConfig,
      ).toEqual(expect.any(Function));
      expect(
        providers.find((provider) => provider.id === "perplexity")?.resolveRuntimeMetadata,
      ).toEqual(expect.any(Function));
    },
  );

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
  ])("$title", ({ params, expectedPluginIds }) => {
    const providers = resolveBundledPluginWebSearchProviders(params);

    expectResolvedPluginIds(providers, expectedPluginIds);
  });

  it("preserves explicit bundled provider entry state", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      config: {
        plugins: {
          entries: {
            perplexity: { enabled: false },
          },
        },
      },
    });

    expectResolvedPluginIdsExcluding(providers, ["perplexity"]);
  });

  it("can resolve bundled providers through the manifest-scoped loader path", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      bundledAllowlistCompat: true,
    });

    expectBundledWebSearchProviders(providers);
  });
});
