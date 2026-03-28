import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

const { resolveBundledPluginWebSearchProvidersMock, resolveRuntimeWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveBundledPluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(
      () => [],
    ),
    resolveRuntimeWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
  }));

vi.mock("../plugins/web-search-providers.js", () => ({
  resolveBundledPluginWebSearchProviders: resolveBundledPluginWebSearchProvidersMock,
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createProvider(params: {
  pluginId: string;
  id: string;
  credentialPath: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  getCredentialValue?: PluginWebSearchProviderEntry["getCredentialValue"];
  getConfiguredCredentialValue?: PluginWebSearchProviderEntry["getConfiguredCredentialValue"];
  createTool?: PluginWebSearchProviderEntry["createTool"];
}): PluginWebSearchProviderEntry {
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} runtime provider`,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    placeholder: `${params.id}-...`,
    signupUrl: `https://example.com/${params.id}`,
    credentialPath: params.credentialPath,
    autoDetectOrder: params.autoDetectOrder,
    requiresCredential: params.requiresCredential,
    getCredentialValue: params.getCredentialValue ?? (() => undefined),
    setCredentialValue: () => {},
    getConfiguredCredentialValue: params.getConfiguredCredentialValue,
    createTool:
      params.createTool ??
      (() => ({
        description: params.id,
        parameters: {},
        execute: async (args) => ({ ...args, provider: params.id }),
      })),
  };
}

describe("web search runtime", () => {
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeEach(async () => {
    vi.resetModules();
    resolveBundledPluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
    ({ runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("executes searches through the active plugin registry", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "custom-search",
        id: "custom",
        credentialPath: "tools.web.search.custom.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "configured",
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("auto-detects a provider from canonical plugin-owned credentials", async () => {
    const provider = createProvider({
      pluginId: "custom-search",
      id: "custom",
      credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: (config) => {
        const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
          | TestPluginWebSearchConfig
          | undefined;
        return pluginConfig?.webSearch?.apiKey;
      },
      createTool: () => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({ ...args, ok: true }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "custom-search": {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "custom-config-key",
              },
            },
          },
        },
      },
    };

    await expect(
      runWebSearch({
        config,
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("treats non-env SecretRefs as configured credentials for provider auto-detect", async () => {
    const provider = createProvider({
      pluginId: "custom-search",
      id: "custom",
      credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: (config) => {
        const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
          | TestPluginWebSearchConfig
          | undefined;
        return pluginConfig?.webSearch?.apiKey;
      },
      createTool: () => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({ ...args, ok: true }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "custom-search": {
            enabled: true,
            config: {
              webSearch: {
                apiKey: {
                  source: "file",
                  provider: "vault",
                  id: "/providers/custom-search/apiKey",
                },
              },
            },
          },
        },
      },
    };

    await expect(
      runWebSearch({
        config,
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("falls back to a keyless provider when no credentials are available", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "duckduckgo",
        id: "duckduckgo",
        credentialPath: "",
        autoDetectOrder: 100,
        requiresCredential: false,
        getCredentialValue: () => "duckduckgo-no-key-needed",
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { query: "fallback", provider: "duckduckgo" },
    });
  });

  it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "alpha-search",
        id: "alpha",
        credentialPath: "tools.web.search.alpha.apiKey",
        autoDetectOrder: 1,
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
      createProvider({
        pluginId: "beta-search",
        id: "beta",
        credentialPath: "tools.web.search.beta.apiKey",
        autoDetectOrder: 2,
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
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "beta",
          diagnostics: [],
        },
        fetch: {
          firecrawl: {
            active: false,
            apiKeySource: "missing",
            diagnostics: [],
          },
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
});
