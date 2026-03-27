import { describe, expect, it } from "vitest";
import { resolveBundledPluginWebSearchProviders } from "./web-search-providers.js";

const WEB_SEARCH_PROVIDER_TEST_TIMEOUT_MS = 300_000;

describe("resolveBundledPluginWebSearchProviders", () => {
  it(
    "returns bundled providers in alphabetical order",
    { timeout: WEB_SEARCH_PROVIDER_TEST_TIMEOUT_MS },
    () => {
      const providers = resolveBundledPluginWebSearchProviders({});

      expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
        "brave:brave",
        "duckduckgo:duckduckgo",
        "exa:exa",
        "firecrawl:firecrawl",
        "google:gemini",
        "xai:grok",
        "moonshot:kimi",
        "perplexity:perplexity",
        "tavily:tavily",
      ]);
      expect(providers.map((provider) => provider.credentialPath)).toEqual([
        "plugins.entries.brave.config.webSearch.apiKey",
        "",
        "plugins.entries.exa.config.webSearch.apiKey",
        "plugins.entries.firecrawl.config.webSearch.apiKey",
        "plugins.entries.google.config.webSearch.apiKey",
        "plugins.entries.xai.config.webSearch.apiKey",
        "plugins.entries.moonshot.config.webSearch.apiKey",
        "plugins.entries.perplexity.config.webSearch.apiKey",
        "plugins.entries.tavily.config.webSearch.apiKey",
      ]);
      expect(
        providers.find((provider) => provider.id === "firecrawl")?.applySelectionConfig,
      ).toEqual(expect.any(Function));
      expect(
        providers.find((provider) => provider.id === "perplexity")?.resolveRuntimeMetadata,
      ).toEqual(expect.any(Function));
    },
  );

  it("can augment restrictive allowlists for bundled compatibility", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["demo-other-plugin"],
        },
      },
      bundledAllowlistCompat: true,
    });

    expect(providers.map((provider) => provider.pluginId)).toEqual([
      "brave",
      "duckduckgo",
      "exa",
      "firecrawl",
      "google",
      "xai",
      "moonshot",
      "perplexity",
      "tavily",
    ]);
  });

  it("does not return bundled providers excluded by a restrictive allowlist without compat", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["demo-other-plugin"],
        },
      },
    });

    expect(providers).toEqual([]);
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

    expect(providers.map((provider) => provider.pluginId)).not.toContain("perplexity");
  });

  it("returns no providers when plugins are globally disabled", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      config: {
        plugins: {
          enabled: false,
        },
      },
    });

    expect(providers).toEqual([]);
  });

  it("can resolve bundled providers through the manifest-scoped loader path", () => {
    const providers = resolveBundledPluginWebSearchProviders({
      bundledAllowlistCompat: true,
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "brave:brave",
      "duckduckgo:duckduckgo",
      "exa:exa",
      "firecrawl:firecrawl",
      "google:gemini",
      "xai:grok",
      "moonshot:kimi",
      "perplexity:perplexity",
      "tavily:tavily",
    ]);
  });

  it("can scope bundled resolution to one plugin id", () => {
    const providers = resolveBundledPluginWebSearchProviders({
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
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "google:gemini",
    ]);
  });
});
