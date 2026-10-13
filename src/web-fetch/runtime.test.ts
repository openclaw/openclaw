/** Tests web_fetch runtime provider selection, credential discovery, and sandbox filtering. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
// mock-isolation: Provider fixtures supply metadata without opening shared machine state.
vi.mock("../plugins/installed-plugin-index-record-state.js", () => ({
  preparePluginMetadataMachineStateAsync: async () => () => {},
}));

vi.mock("../plugins/bundled-discovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/bundled-discovery-state.js")>()),
  prepareBundledDiscoveryMode: async () => () => {},
}));
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createWebFetchTestProvider,
  type WebFetchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebFetchConfig = {
  webFetch?: {
    apiKey?: unknown;
  };
};

const {
  getActivePluginRegistryVersionMock,
  resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProvidersMock,
} = vi.hoisted(() => ({
  getActivePluginRegistryVersionMock: vi.fn(() => 1),
  resolvePluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistryVersion: getActivePluginRegistryVersionMock,
  };
});

// mock-isolation: Fetch execution fixtures supply synthetic provider acquisitions without plugin discovery.
vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProvidersAsync: resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProvidersAsync: resolveRuntimeWebFetchProvidersMock,
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

function createThirdPartyFetchProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "third-party-fetch",
    id: "thirdparty",
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    autoDetectOrder: 0,
    getConfiguredCredentialValue: () => "runtime-key",
    ...overrides,
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: { enabled: true, config: { webFetch: { apiKey } } },
      },
    },
  };
}

type ResolvedWebFetchDefinition = NonNullable<
  Awaited<ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>>
>;

function requireResolvedWebFetch(
  resolved: Awaited<
    ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>
  >,
): ResolvedWebFetchDefinition {
  if (!resolved) {
    throw new Error("expected resolved web fetch definition");
  }
  return resolved;
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;

  beforeAll(async () => {
    ({ resolveWebFetchDefinition } = await import("./runtime.js"));
  });

  beforeEach(() => {
    getActivePluginRegistryVersionMock.mockReset();
    getActivePluginRegistryVersionMock.mockReturnValue(1);
    resolvePluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolvePluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", async () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig({
      source: "env",
      provider: "default",
      id: "AWS_SECRET_ACCESS_KEY",
    });

    await withEnvAsync({ FIRECRAWL_API_KEY: "" }, async () => {
      expect(await resolveWebFetchDefinition({ config })).toBeNull();
    });
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const unrelated = createThirdPartyFetchProvider({
      getConfiguredCredentialValue: () => {
        throw new Error("selected provider resolution probed unrelated credentials");
      },
    });
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([unrelated, provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([unrelated, provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };

    const resolved = await resolveWebFetchDefinition({
      config: {},
      runtimeWebFetch,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("auto-detects providers from provider-declared env vars", async () => {
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    await withEnvAsync({ FIRECRAWL_API_KEY: "firecrawl-env-key" }, async () => {
      const resolved = await resolveWebFetchDefinition({
        config: {},
      });

      expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
    });
  });

  it("uses an explicitly configured keyless provider without an API key", async () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = await resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "firecrawl" } } },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("does not auto-detect a keyless provider without a credential", async () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    expect(await resolveWebFetchDefinition({ config: {} })).toBeNull();
  });

  it("retries provider discovery after an empty plugin snapshot", async () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const config = createFirecrawlPluginConfig("firecrawl-key");
    resolvePluginWebFetchProvidersMock.mockReturnValueOnce([]).mockReturnValueOnce([provider]);

    expect(await resolveWebFetchDefinition({ config })).toBeNull();
    expect(requireResolvedWebFetch(await resolveWebFetchDefinition({ config })).provider.id).toBe(
      "firecrawl",
    );

    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(2);
  });

  it.each(["detached", "published"])(
    "invalidates provider discovery when the same %s config object changes",
    async (mode) => {
      const createTool = vi.fn(createFirecrawlProvider().createTool);
      const firecrawl = createFirecrawlProvider({
        getConfiguredCredentialValue: () => "firecrawl-key",
        createTool,
      });
      const external = createThirdPartyFetchProvider();
      resolvePluginWebFetchProvidersMock
        .mockReturnValueOnce([firecrawl])
        .mockReturnValueOnce([external]);
      const config = {
        tools: { web: { fetch: { provider: "firecrawl" } } },
      } as OpenClawConfig & { tools: { web: { fetch: { provider: string } } } };
      const resolveProvider = async () =>
        requireResolvedWebFetch(await resolveWebFetchDefinition({ config })).provider.id;

      if (mode === "published") {
        setRuntimeConfigSnapshot(config);
      }
      expect(await resolveProvider()).toBe("firecrawl");
      expect(await resolveProvider()).toBe("firecrawl");
      expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(1);
      expect(createTool).toHaveBeenCalledTimes(2);

      config.tools.web.fetch.provider = "thirdparty";
      if (mode === "published") {
        setRuntimeConfigSnapshot(config);
      }
      expect(await resolveProvider()).toBe("thirdparty");
      expect(await resolveProvider()).toBe("thirdparty");
      expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(2);
    },
  );

  it("evicts superseded provider discovery cache entries", async () => {
    const firstFirecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    const secondFirecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock
      .mockReturnValueOnce([firstFirecrawl])
      .mockReturnValueOnce([external])
      .mockReturnValueOnce([secondFirecrawl]);
    getActivePluginRegistryVersionMock
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(10);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = requireResolvedWebFetch(await resolveWebFetchDefinition({ config }));
    const second = requireResolvedWebFetch(await resolveWebFetchDefinition({ config }));
    const third = requireResolvedWebFetch(await resolveWebFetchDefinition({ config }));

    expect(first.provider).toBe(firstFirecrawl);
    expect(second.provider.id).toBe("thirdparty");
    expect(third.provider).toBe(secondFirecrawl);
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(3);
  });

  it("reuses runtime provider discovery across runtime-selected providers", async () => {
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([firecrawl, external]);
    const config = {} as OpenClawConfig;

    const first = requireResolvedWebFetch(
      await resolveWebFetchDefinition({
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
      await resolveWebFetchDefinition({
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
    expect(resolveRuntimeWebFetchProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("auto-detects fallback credentials when the primary fetch key is blank", async () => {
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

    const resolved = await resolveWebFetchDefinition({
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

  it("falls back to auto-detect when the configured provider is invalid", async () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = await resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "does-not-exist" } } },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on trusted providers even when runtime providers are preferred", async () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = await resolveWebFetchDefinition({
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

  it("prefers an explicitly configured non-bundled provider over runtime metadata", async () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([bundled, external]);

    const resolved = await resolveWebFetchDefinition({
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
