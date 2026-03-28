import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let resetWebSearchProviderSnapshotCacheForTests: WebSearchProvidersRuntimeModule["__testing"]["resetWebSearchProviderSnapshotCacheForTests"];
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let loaderModule: typeof import("./loader.js");
let manifestRegistryModule: ManifestRegistryModule;

const DEFAULT_WEB_SEARCH_WORKSPACE = "/tmp/workspace";
const EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS = [
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

function createBraveAllowConfig() {
  return {
    plugins: {
      allow: ["brave"],
    },
  };
}

function createWebSearchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createSnapshotParams(params?: {
  config?: { plugins?: Record<string, unknown> };
  env?: NodeJS.ProcessEnv;
  bundledAllowlistCompat?: boolean;
  workspaceDir?: string;
}) {
  return {
    config: params?.config ?? createBraveAllowConfig(),
    env: params?.env ?? createWebSearchEnv(),
    bundledAllowlistCompat: params?.bundledAllowlistCompat ?? true,
    workspaceDir: params?.workspaceDir ?? DEFAULT_WEB_SEARCH_WORKSPACE,
  };
}

function toRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  return providers.map((provider) => `${provider.pluginId}:${provider.id}`);
}

function expectBundledRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  expect(toRuntimeProviderKeys(providers)).toEqual(
    EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS,
  );
}

function createManifestRegistryFixture() {
  return {
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
  };
}

function expectLoaderCallCount(count: number) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(count);
}

function expectScopedWebSearchCandidates(pluginIds: readonly string[]) {
  expect(loadPluginManifestRegistryMock).toHaveBeenCalled();
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      onlyPluginIds: [...pluginIds],
    }),
  );
}

describe("resolvePluginWebSearchProviders", () => {
  beforeAll(async () => {
    ({ createEmptyPluginRegistry } = await import("./registry.js"));
    manifestRegistryModule = await import("./manifest-registry.js");
    loaderModule = await import("./loader.js");
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    ({
      resolvePluginWebSearchProviders,
      resolveRuntimeWebSearchProviders,
      __testing: { resetWebSearchProviderSnapshotCacheForTests },
    } = await import("./web-search-providers.runtime.js"));
  });

  beforeEach(() => {
    resetWebSearchProviderSnapshotCacheForTests();
    loadPluginManifestRegistryMock = vi
      .spyOn(manifestRegistryModule, "loadPluginManifestRegistry")
      .mockReturnValue(
        createManifestRegistryFixture() as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
          ...args: unknown[]
        ) => infer R
          ? R
          : never,
      );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders = buildMockedWebSearchProviders(params);
        return registry;
      });
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.useRealTimers();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("loads bundled providers through the plugin loader in alphabetical order", () => {
    const providers = resolvePluginWebSearchProviders({});

    expectBundledRuntimeProviderKeys(providers);
    expectLoaderCallCount(1);
  });

  it("scopes plugin loading to manifest-declared web-search candidates", () => {
    resolvePluginWebSearchProviders({});

    expectScopedWebSearchCandidates(["brave"]);
  });

  it("memoizes snapshot provider resolution for the same config and env", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv();
    const runtimeParams = createSnapshotParams({ config, env });

    const first = resolvePluginWebSearchProviders(runtimeParams);
    const second = resolvePluginWebSearchProviders(runtimeParams);

    expect(second).toBe(first);
    expectLoaderCallCount(1);
  });

  it("invalidates the snapshot cache when config or env contents change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({ OPENCLAW_HOME: "/tmp/openclaw-home-a" });

    resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));
    config.plugins.allow = ["perplexity"];
    env.OPENCLAW_HOME = "/tmp/openclaw-home-b";
    resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

    expectLoaderCallCount(2);
  });

  it.each([
    {
      title: "skips web-search snapshot memoization when plugin cache opt-outs are set",
      env: {
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      },
    },
    {
      title: "skips web-search snapshot memoization when discovery cache ttl is zero",
      env: {
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
      },
    },
  ])("$title", ({ env }) => {
    const config = createBraveAllowConfig();

    resolvePluginWebSearchProviders(createSnapshotParams({ config, env: createWebSearchEnv(env) }));
    resolvePluginWebSearchProviders(createSnapshotParams({ config, env: createWebSearchEnv(env) }));

    expectLoaderCallCount(2);
  });

  it("does not leak host Vitest env into an explicit non-Vitest cache key", () => {
    const originalVitest = process.env.VITEST;
    const config = {};
    const env = createWebSearchEnv();

    try {
      delete process.env.VITEST;
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

      process.env.VITEST = "1";
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("expires web-search snapshot memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    });
    const runtimeParams = createSnapshotParams({ config, env });

    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(4);
    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(2);
    resolvePluginWebSearchProviders(runtimeParams);

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates web-search snapshots when cache-control env values change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    });

    resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

    env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";

    resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

    expectLoaderCallCount(2);
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

    expect(toRuntimeProviderKeys(providers)).toEqual(["custom-search:custom"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
