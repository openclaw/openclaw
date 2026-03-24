import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RegistryModule = typeof import("./registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebSearchProvidersRuntimeModule = typeof import("./web-search-providers.runtime.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");

const BUNDLED_WEB_SEARCH_PROVIDERS = [
  { pluginId: "brave", id: "brave", order: 10 },
  { pluginId: "google", id: "gemini", order: 20 },
  { pluginId: "xai", id: "grok", order: 30 },
  { pluginId: "moonshot", id: "kimi", order: 40 },
  { pluginId: "perplexity", id: "perplexity", order: 50 },
  { pluginId: "firecrawl", id: "firecrawl", order: 60 },
  { pluginId: "exa", id: "exa", order: 65 },
  { pluginId: "tavily", id: "tavily", order: 70 },
  { pluginId: "duckduckgo", id: "duckduckgo", order: 100 },
] as const;

let createEmptyPluginRegistry: RegistryModule["createEmptyPluginRegistry"];
let loadPluginManifestRegistryMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resolvePluginWebSearchProviders: WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"];
let resolveRuntimeWebSearchProviders: WebSearchProvidersRuntimeModule["resolveRuntimeWebSearchProviders"];
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;

function buildMockedWebSearchProviders(params?: {
  config?: { plugins?: Record<string, unknown> };
}) {
  const plugins = params?.config?.plugins as
    | {
        enabled?: boolean;
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      }
    | undefined;
  if (plugins?.enabled === false) {
    return [];
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
  return webSearchProviders;
}

describe("resolvePluginWebSearchProviders", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ createEmptyPluginRegistry } = await import("./registry.js"));
    const manifestRegistryModule = await import("./manifest-registry.js");
    loadPluginManifestRegistryMock = vi
      .spyOn(manifestRegistryModule, "loadPluginManifestRegistry")
      .mockReturnValue({
        plugins: [
          {
            id: "brave",
            origin: "bundled",
            rootDir: "/tmp/brave",
            source: "/tmp/brave/index.js",
            manifestPath: "/tmp/brave/openclaw.plugin.json",
            channels: [],
            providers: [],
            skills: [],
            hooks: [],
            configUiHints: { "webSearch.apiKey": { label: "key" } },
          },
          {
            id: "noise",
            origin: "bundled",
            rootDir: "/tmp/noise",
            source: "/tmp/noise/index.js",
            manifestPath: "/tmp/noise/openclaw.plugin.json",
            channels: [],
            providers: [],
            skills: [],
            hooks: [],
            configUiHints: { unrelated: { label: "nope" } },
          },
        ],
        diagnostics: [],
      } as ManifestRegistryModule["loadPluginManifestRegistry"] extends (...args: any[]) => infer R
        ? R
        : never);
    const loaderModule = await import("./loader.js");
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders = buildMockedWebSearchProviders(params);
        return registry;
      });
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    ({ resolvePluginWebSearchProviders, resolveRuntimeWebSearchProviders } =
      await import("./web-search-providers.runtime.js"));
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.useRealTimers();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("loads bundled providers through the plugin loader in alphabetical order", () => {
    const providers = resolvePluginWebSearchProviders({});

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
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("scopes plugin loading to manifest-declared web-search candidates", () => {
    resolvePluginWebSearchProviders({});

    expect(loadPluginManifestRegistryMock).toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["brave"],
      }),
    );
  });

  it("memoizes snapshot provider resolution for the same config and env", () => {
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    const first = resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    const second = resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(second).toBe(first);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the snapshot cache when config or env contents change in place", () => {
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home-a",
    } as NodeJS.ProcessEnv;

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    config.plugins.allow = ["perplexity"];
    env.OPENCLAW_HOME = "/tmp/openclaw-home-b";
    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("skips web-search snapshot memoization when plugin cache opt-outs are set", () => {
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    } as NodeJS.ProcessEnv;

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("skips web-search snapshot memoization when discovery cache ttl is zero", () => {
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
    } as NodeJS.ProcessEnv;

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates the snapshot cache when global Vitest fallback changes", () => {
    const originalVitest = process.env.VITEST;
    const config = {};
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    try {
      delete process.env.VITEST;
      resolvePluginWebSearchProviders({
        config,
        env,
        bundledAllowlistCompat: true,
        workspaceDir: "/tmp/workspace",
      });

      process.env.VITEST = "1";
      resolvePluginWebSearchProviders({
        config,
        env,
        bundledAllowlistCompat: true,
        workspaceDir: "/tmp/workspace",
      });
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("expires web-search snapshot memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    } as NodeJS.ProcessEnv;

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    vi.advanceTimersByTime(4);
    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });
    vi.advanceTimersByTime(2);
    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates web-search snapshots when cache-control env values change in place", () => {
    const config = {
      plugins: {
        allow: ["brave"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    } as NodeJS.ProcessEnv;

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";

    resolvePluginWebSearchProviders({
      config,
      env,
      bundledAllowlistCompat: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
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
