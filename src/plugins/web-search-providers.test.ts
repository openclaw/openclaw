import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "./web-search-providers.js";

describe("resolvePluginWebSearchProviders", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("returns bundled providers in auto-detect order", () => {
    const providers = resolvePluginWebSearchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "brave:brave",
      "google:gemini",
      "xai:grok",
      "moonshot:kimi",
      "perplexity:perplexity",
      "firecrawl:firecrawl",
    ]);
    expect(providers.map((provider) => provider.credentialPath)).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.gemini.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.kimi.apiKey",
      "tools.web.search.perplexity.apiKey",
      "tools.web.search.firecrawl.apiKey",
    ]);
    expect(providers.find((provider) => provider.id === "firecrawl")?.applySelectionConfig).toEqual(
      expect.any(Function),
    );
    expect(
      providers.find((provider) => provider.id === "perplexity")?.resolveRuntimeMetadata,
    ).toEqual(expect.any(Function));
  });

  it("can augment restrictive allowlists for bundled compatibility", () => {
    const providers = resolvePluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledAllowlistCompat: true,
    });

    expect(providers.map((provider) => provider.pluginId)).toEqual([
      "brave",
      "google",
      "xai",
      "moonshot",
      "perplexity",
      "firecrawl",
    ]);
  });

  it("does not return bundled providers excluded by a restrictive allowlist without compat", () => {
    const providers = resolvePluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
    });

    expect(providers).toEqual([]);
  });

  it("preserves explicit bundled provider entry state", () => {
    const providers = resolvePluginWebSearchProviders({
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
    const providers = resolvePluginWebSearchProviders({
      config: {
        plugins: {
          enabled: false,
        },
      },
    });

    expect(providers).toEqual([]);
  });

  it("prefers the active plugin registry for runtime resolution", () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        autoDetectOrder: 1,
        credentialPath: "tools.web.search.custom.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async () => ({}),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

    const providers = resolveRuntimeWebSearchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "custom-search:custom",
    ]);
  });
});
