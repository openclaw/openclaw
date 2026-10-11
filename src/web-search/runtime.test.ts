import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Web search runtime tests cover provider resolution and search execution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

type WebSearchProviderResolverParams = {
  config?: OpenClawConfig;
  onlyPluginIds?: readonly string[];
  origin?: string;
};

type ManifestContractOwnerParams = {
  config?: OpenClawConfig;
  contract?: string;
  origin?: string;
  value?: string;
};

const {
  resolveManifestContractOwnerPluginIdMock,
  resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProvidersMock,
} = vi.hoisted(() => ({
  resolveManifestContractOwnerPluginIdMock: vi.fn(
    (_params: ManifestContractOwnerParams): string | undefined => undefined,
  ),
  resolvePluginWebSearchProvidersMock: vi.fn(
    (_params?: WebSearchProviderResolverParams): PluginWebSearchProviderEntry[] => [],
  ),
  resolveRuntimeWebSearchProvidersMock: vi.fn(
    (_params?: WebSearchProviderResolverParams): PluginWebSearchProviderEntry[] => [],
  ),
}));

vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
}));

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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockCallParam(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[index]?.[0]);
}

function createDuckDuckGoSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "duckduckgo",
    id: "duckduckgo",
    credentialPath: "",
    autoDetectOrder: 100,
    requiresCredential: false,
    ...overrides,
  });
}

describe("web search runtime", () => {
  let hasUsableWebSearchProvider: typeof import("./runtime.js").hasUsableWebSearchProvider;
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;
  let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
  let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    ({ hasUsableWebSearchProvider, runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../config/config.js"));
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    resolveManifestContractOwnerPluginIdMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
    resolvePluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts the prepared provider selection without rediscovering providers", async () => {
    expect(
      await hasUsableWebSearchProvider({
        config: {},
        runtimeWebSearch: {
          providerSource: "auto-detect",
          selectedProvider: "brave",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
        preferRuntimeProviders: true,
      }),
    ).toBe(true);
    expect(resolveRuntimeWebSearchProvidersMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("does not fall back to another provider after parent cancellation", async () => {
    const controller = new AbortController();
    const abortReason = new Error("parent run cancelled");
    abortReason.name = "AbortError";
    const firstExecute = vi.fn(
      async (_args: Record<string, unknown>, context?: { signal?: AbortSignal }) => {
        expect(context?.signal).toBe(controller.signal);
        controller.abort(abortReason);
        throw new Error("provider cleanup failed after cancellation");
      },
    );
    const fallbackExecute = vi.fn(async () => ({ ok: true }));
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        credentialPath: "",
        createTool: () => ({
          description: "first",
          parameters: {},
          execute: firstExecute,
        }),
      }),
      createCustomSearchProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "",
        autoDetectOrder: 2,
        getConfiguredCredentialValue: () => "configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: fallbackExecute,
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: createCustomSearchConfig("custom-config-key"),
        args: { query: "abort fallback" },
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(firstExecute).toHaveBeenCalledOnce();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it("auto-detects a provider from the active agent auth profile", async () => {
    const defaultAgentDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-web-search-default-"));
    const activeAgentDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-web-search-active-"));
    tempDirs.push(defaultAgentDir, activeAgentDir);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: activeAgentDir,
        store: createOAuthAuthProfileStore({
          provider: "xai",
          profileId: "xai:active",
          access: "xai-active-oauth-token",
          refresh: "xai-active-refresh-token",
        }),
      },
    ]);

    const provider = createCustomSearchProvider({
      pluginId: "xai",
      id: "grok",
      authProviderId: "xai",
      credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([
      provider,
      createDuckDuckGoSearchProvider(),
    ]);
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { agentDir: defaultAgentDir },
          side: { agentDir: activeAgentDir },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      await hasUsableWebSearchProvider({
        agentDir: activeAgentDir,
        config,
        preferRuntimeProviders: true,
      }),
    ).toBe(true);

    await expect(
      runWebSearch({
        agentDir: activeAgentDir,
        config,
        args: { query: "active-agent oauth-backed web search" },
      }),
    ).resolves.toEqual({
      provider: "grok",
      result: { query: "active-agent oauth-backed web search", ok: true },
    });
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

  it("falls back when an auto-selected provider returns a structured error payload", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => ({
            error: "missing_google_api_key",
            message: "google key missing",
          }),
        }),
      }),
      createWebSearchTestProvider({
        pluginId: "backup-search",
        id: "backup",
        credentialPath: "tools.web.search.backup.apiKey",
        autoDetectOrder: 2,
        getConfiguredCredentialValue: () => "backup-configured",
        getCredentialValue: () => "backup-configured",
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback-structured-error" },
      }),
    ).resolves.toEqual({
      provider: "backup",
      result: { query: "fallback-structured-error", provider: "backup" },
    });
  });

  it("scopes runtime provider loading through manifest ownership when provider id differs from plugin id", async () => {
    resolveManifestContractOwnerPluginIdMock.mockImplementation(({ value }) =>
      value === "gemini" ? "google" : undefined,
    );
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        id: "gemini",
        pluginId: "google",
      }),
    ]);

    const result = await runWebSearch({
      config: {},
      runtimeWebSearch: {
        providerConfigured: "gemini",
        selectedProvider: "gemini",
        providerSource: "configured",
        diagnostics: [],
      },
      args: { query: "configured-gemini" },
    });
    expect(result.provider).toBe("gemini");

    expect(mockCallParam(resolveRuntimeWebSearchProvidersMock).onlyPluginIds).toEqual(["google"]);
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "google",
        args: { query: "explicit-null-tool" },
      }),
    ).rejects.toThrow('web_search provider "google" is not available.');
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider(),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "missing-id",
        args: { query: "explicit-missing" },
      }),
    ).rejects.toThrow('Unknown web_search provider "missing-id".');
  });

  it("honors preferRuntimeProviders during execution", async () => {
    const configuredProvider = createGoogleSearchProvider();
    const runtimeProvider = createWebSearchTestProvider({
      pluginId: "runtime-search",
      id: "runtime-search",
      credentialPath: "",
      autoDetectOrder: 0,
      requiresCredential: false,
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([configuredProvider, runtimeProvider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([configuredProvider]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
              },
            },
          },
        },
        runtimeWebSearch: {
          providerConfigured: "runtime-search",
          selectedProvider: "runtime-search",
          providerSource: "configured",
          diagnostics: [],
        },
        preferRuntimeProviders: false,
        args: { query: "prefer-config" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { query: "prefer-config", provider: "google" },
    });
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider({
        createTool: () => null,
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "all-null-tools" },
      }),
    ).rejects.toThrow("web_search is enabled but no provider is currently available.");
  });
});
