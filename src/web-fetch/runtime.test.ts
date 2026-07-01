/** Tests web_fetch runtime provider selection, credential discovery, and sandbox filtering. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { withEnv } from "../test-utils/env.js";
import {
  createWebFetchTestProvider,
  type WebFetchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebFetchConfig = {
  webFetch?: {
    apiKey?: unknown;
  };
};

const { resolvePluginWebFetchProvidersMock, resolveRuntimeWebFetchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
    resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  }),
);

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
}));

function getFirecrawlApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
    | TestPluginWebFetchConfig
    | undefined;
  return pluginConfig?.webFetch?.apiKey;
}

function createFirecrawlProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "firecrawl",
    id: "firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
    autoDetectOrder: 1,
    ...overrides,
  });
}

function createThirdPartyFetchProvider(): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "third-party-fetch",
    id: "thirdparty",
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    autoDetectOrder: 0,
    getConfiguredCredentialValue: () => "runtime-key",
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: {
          enabled: true,
          config: {
            webFetch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

type ResolvedWebFetchDefinition = NonNullable<
  ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>
>;

function requireResolvedWebFetch(
  resolved: ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>,
): ResolvedWebFetchDefinition {
  if (!resolved) {
    throw new Error("expected resolved web fetch definition");
  }
  return resolved;
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;
  let clearWebFetchRuntimeCachesForTest: typeof import("./runtime.js").clearWebFetchRuntimeCachesForTest;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ clearWebFetchRuntimeCachesForTest, resolveWebFetchDefinition } =
      await import("./runtime.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    clearWebFetchRuntimeCachesForTest();
    resolvePluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolvePluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearWebFetchRuntimeCachesForTest();
  });

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig({
      source: "env",
      provider: "default",
      id: "AWS_SECRET_ACCESS_KEY",
    });

    withEnv({ FIRECRAWL_API_KEY: "" }, () => {
      expect(resolveWebFetchDefinition({ config })).toBeNull();
    });
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const provider = createFirecrawlProvider({
      createTool: ({ runtimeMetadata }) => ({
        description: "firecrawl",
        parameters: {},
        execute: async (args) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
      }),
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };

    const resolved = resolveWebFetchDefinition({
      config: {},
      runtimeWebFetch,
      preferRuntimeProviders: true,
    });

    const webFetch = requireResolvedWebFetch(resolved);
    expect(webFetch.provider.id).toBe("firecrawl");
    await expect(
      webFetch.definition.execute({
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).resolves.toEqual({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 1000,
      provider: "firecrawl",
    });
  });

  it("auto-detects providers from provider-declared env vars", () => {
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    withEnv({ FIRECRAWL_API_KEY: "firecrawl-env-key" }, () => {
      const resolved = resolveWebFetchDefinition({
        config: {},
      });

      expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
    });
  });

  it("uses an explicitly configured keyless provider without an API key", () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("does not auto-detect a keyless provider without a credential", () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    expect(resolveWebFetchDefinition({ config: {} })).toBeNull();
  });

  it("caches provider resolution misses for the same config snapshot", () => {
    const config = {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveWebFetchDefinition({ config })).toBeNull();
    expect(resolveWebFetchDefinition({ config })).toBeNull();

    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("caches provider definitions for the same config and runtime selection", () => {
    const createTool = vi.fn(() => ({
      description: "firecrawl",
      parameters: {},
      execute: async () => ({}),
    }));
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
      createTool,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const second = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));

    expect(first).toBe(second);
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(1);
    expect(createTool).toHaveBeenCalledTimes(1);
  });

  it("keys provider definition cache by runtime-selected provider", () => {
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([firecrawl, external]);
    const config = {} as OpenClawConfig;

    const first = requireResolvedWebFetch(
      resolveWebFetchDefinition({
        config,
        preferRuntimeProviders: true,
        runtimeWebFetch: {
          providerSource: "auto-detect",
          selectedProvider: "firecrawl",
          selectedProviderKeySource: "env",
          diagnostics: [],
        },
      }),
    );
    const second = requireResolvedWebFetch(
      resolveWebFetchDefinition({
        config,
        preferRuntimeProviders: true,
        runtimeWebFetch: {
          providerSource: "configured",
          selectedProvider: "thirdparty",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
      }),
    );

    expect(first.provider.id).toBe("firecrawl");
    expect(second.provider.id).toBe("thirdparty");
    expect(resolveRuntimeWebFetchProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("auto-detects providers from configured fallback credentials", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialFallback: (config) => {
        const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        return pluginConfig?.webSearch?.apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: pluginConfig.webSearch.apiKey,
            };
      },
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webSearch: {
                  apiKey: "shared-firecrawl-key",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("auto-detects fallback credentials when the primary fetch key is blank", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
      getConfiguredCredentialFallback: (config) => {
        const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        return pluginConfig?.webSearch?.apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: pluginConfig.webSearch.apiKey,
            };
      },
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "",
                },
                webSearch: {
                  apiKey: "shared-firecrawl-key",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "does-not-exist",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on trusted providers even when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: true,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledWith({
      config: {},
      sandboxed: true,
    });
    expect(resolveRuntimeWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses runtime providers for non-sandboxed web fetch when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });

  it("resolves an explicitly configured non-bundled provider from plugin providers", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled, external]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "thirdparty" } } },
      } as OpenClawConfig,
      sandboxed: false,
      preferRuntimeProviders: false,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });

  it("prefers an explicitly configured non-bundled provider over runtime metadata", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([bundled, external]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "thirdparty" } } },
      } as OpenClawConfig,
      runtimeWebFetch: {
        providerSource: "auto-detect",
        selectedProvider: "firecrawl",
        selectedProviderKeySource: "env",
        diagnostics: [],
      },
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });
});
