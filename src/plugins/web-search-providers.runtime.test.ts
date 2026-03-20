import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "./web-search-providers.runtime.js";

const BUNDLED_WEB_SEARCH_PROVIDERS = [
  { pluginId: "brave", id: "brave", order: 10 },
  { pluginId: "google", id: "gemini", order: 20 },
  { pluginId: "xai", id: "grok", order: 30 },
  { pluginId: "moonshot", id: "kimi", order: 40 },
  { pluginId: "perplexity", id: "perplexity", order: 50 },
  { pluginId: "firecrawl", id: "firecrawl", order: 60 },
  { pluginId: "tavily", id: "tavily", order: 70 },
] as const;

const { loadOpenClawPluginsMock } = vi.hoisted(() => ({
  loadOpenClawPluginsMock: vi.fn((params?: { config?: { plugins?: Record<string, unknown> } }) => {
    const plugins = params?.config?.plugins as
      | {
          enabled?: boolean;
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        }
      | undefined;
    if (plugins?.enabled === false) {
      return { webSearchProviders: [] };
    }
    const allow = Array.isArray(plugins?.allow) && plugins.allow.length > 0 ? plugins.allow : null;
    const entries = plugins?.entries ?? {};
    const webSearchProviders = BUNDLED_WEB_SEARCH_PROVIDERS.filter((provider) => {
      if (allow && !allow.includes(provider.pluginId)) {
        return false;
      }
      if (entries[provider.pluginId]?.enabled === false) {
        return false;
      }
      return true;
    }).map((provider) => ({
      pluginId: provider.pluginId,
      pluginName: provider.pluginId,
      source: "test" as const,
      provider: {
        id: provider.id,
        label: provider.id,
        hint: `${provider.id} provider`,
        envVars: [`${provider.id.toUpperCase()}_API_KEY`],
        placeholder: `${provider.id}-...`,
        signupUrl: `https://example.com/${provider.id}`,
        autoDetectOrder: provider.order,
        credentialPath: `plugins.entries.${provider.pluginId}.config.webSearch.apiKey`,
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: provider.id,
          parameters: {},
          execute: async () => ({}),
        }),
      },
    }));
    return { webSearchProviders };
  }),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

describe("resolvePluginWebSearchProviders", () => {
  beforeEach(() => {
    loadOpenClawPluginsMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("loads bundled providers through the plugin loader in auto-detect order", () => {
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
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
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
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
