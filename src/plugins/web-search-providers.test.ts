import { describe, expect, it } from "vitest";
import { resolvePluginWebSearchProviders } from "./web-search-providers.js";

describe("resolvePluginWebSearchProviders", () => {
  it("returns bundled providers in auto-detect order", () => {
    const providers = resolvePluginWebSearchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "brave:brave",
      "google:gemini",
      "xai:grok",
      "moonshot:kimi",
      "perplexity:perplexity",
      "firecrawl:firecrawl",
      "tavily:tavily",
    ]);
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
      "tavily",
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
});
