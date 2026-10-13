import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import {
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

const { resolvePluginWebSearchProvidersMock, resolveRuntimeWebSearchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
    resolveRuntimeWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
  }),
);

// mock-isolation: Snapshot selection uses synthetic providers without plugin discovery.
vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: () => undefined,
}));
// mock-isolation: Keep provider runtime loading outside the snapshot lifecycle fixture.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createCustomSearchTool() {
  return {
    description: "custom",
    parameters: {},
    execute: async (args: Record<string, unknown>) => ({ ...args, ok: true }),
  };
}

function getCustomSearchApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
    | TestPluginWebSearchConfig
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function createCustomSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "custom-search",
    id: "custom",
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    autoDetectOrder: 1,
    getConfiguredCredentialValue: getCustomSearchApiKey,
    createTool: createCustomSearchTool,
    ...overrides,
  });
}

function createCustomSearchConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "custom-search": {
          enabled: true,
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

function createGoogleSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "google",
    id: "google",
    credentialPath: "tools.web.search.google.apiKey",
    autoDetectOrder: 1,
    getConfiguredCredentialValue: () => "configured",
    getCredentialValue: () => "configured",
    ...overrides,
  });
}

describe("web search runtime snapshots", () => {
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;
  let clearRuntimeConfigSnapshot: typeof import("../config/runtime-snapshot.js").clearRuntimeConfigSnapshot;
  let setRuntimeConfigSnapshot: typeof import("../config/runtime-snapshot.js").setRuntimeConfigSnapshot;

  beforeAll(async () => {
    ({ runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../config/runtime-snapshot.js"));
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("uses the active resolved runtime config for matching source config callers", async () => {
    const provider = createCustomSearchProvider({
      createTool: ({ config }) => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({
          ...args,
          apiKey: getCustomSearchApiKey(config),
        }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const sourceConfig = createCustomSearchConfig({
      source: "exec",
      provider: "mockexec",
      id: "custom-search/api-key",
    });
    const resolvedConfig = createCustomSearchConfig("resolved-custom-key");

    activateSecretsRuntimeSnapshot({
      sourceConfig,
      config: resolvedConfig,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "custom",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    await expect(
      runWebSearch({
        config: structuredClone(sourceConfig),
        args: { query: "runtime-source" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: {
        query: "runtime-source",
        apiKey: "resolved-custom-key",
      },
    });
  });

  it("can prefer an explicitly resolved input config over a pinned config snapshot", async () => {
    const provider = createCustomSearchProvider({
      createTool: ({ config }) => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({
          ...args,
          apiKey: getCustomSearchApiKey(config),
        }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    setRuntimeConfigSnapshot(
      createCustomSearchConfig({
        source: "env",
        provider: "default",
        id: "CUSTOM_SEARCH_API_KEY",
      }),
    );

    await expect(
      runWebSearch({
        config: createCustomSearchConfig("resolved-custom-key"),
        preferInputConfig: true,
        providerId: "custom",
        preferRuntimeProviders: false,
        args: { query: "resolved-input" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: {
        query: "resolved-input",
        apiKey: "resolved-custom-key",
      },
    });
  });

  it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "alpha-search",
        id: "alpha",
        credentialPath: "tools.web.search.alpha.apiKey",
        autoDetectOrder: 1,
        getConfiguredCredentialValue: () => "alpha-configured",
        getCredentialValue: () => "alpha-configured",
        createTool: ({ runtimeMetadata }) => ({
          description: "alpha",
          parameters: {},
          execute: async (args) => ({
            ...args,
            provider: "alpha",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
        }),
      }),
      createWebSearchTestProvider({
        pluginId: "beta-search",
        id: "beta",
        credentialPath: "tools.web.search.beta.apiKey",
        autoDetectOrder: 2,
        getConfiguredCredentialValue: () => "beta-configured",
        getCredentialValue: () => "beta-configured",
        createTool: ({ runtimeMetadata }) => ({
          description: "beta",
          parameters: {},
          execute: async (args) => ({
            ...args,
            provider: "beta",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
        }),
      }),
    ]);

    activateSecretsRuntimeSnapshot({
      sourceConfig: {},
      config: {},
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "beta",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    await expect(
      runWebSearch({
        config: {},
        args: { query: "runtime" },
      }),
    ).resolves.toEqual({
      provider: "beta",
      result: { query: "runtime", provider: "beta", runtimeSelectedProvider: "beta" },
    });
  });

  it("ignores auto-detected keyless runtime metadata when no provider is configured", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "parallel",
        id: "parallel-free",
        credentialPath: "",
        autoDetectOrder: 76,
        requiresCredential: false,
      }),
    ]);

    activateSecretsRuntimeSnapshot({
      sourceConfig: {},
      config: {},
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "parallel-free",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    await expect(
      runWebSearch({
        config: {},
        args: { query: "stale-keyless-runtime" },
      }),
    ).rejects.toThrow("web_search is disabled or no provider is available.");
  });

  it("ignores auto-detected runtime metadata after config names an unknown provider", async () => {
    const createTool = vi.fn(() => createCustomSearchTool());
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool,
      }),
    ]);
    const config = {
      tools: {
        web: {
          search: {
            provider: "missing-id",
          },
        },
      },
    };

    activateSecretsRuntimeSnapshot({
      sourceConfig: config,
      config: structuredClone(config),
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "google",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    await expect(
      runWebSearch({
        config: structuredClone(config),
        args: { query: "runtime-config-typo" },
      }),
    ).rejects.toThrow("web_search is disabled or no provider is available.");
    expect(createTool).not.toHaveBeenCalled();
  });
});
