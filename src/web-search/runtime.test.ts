import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

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

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
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

  beforeAll(async () => {
    ({ runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
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
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

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
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

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

  it("falls back to configured provider when primary fails with rate_limit", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async () => {
            throw new FailoverError("rate limited", {
              reason: "rate_limit",
              provider: "primary",
              status: 429,
            });
          },
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["fallback"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "fallback",
      result: { query: "test", provider: "fallback" },
    });
  });

  it("falls back to configured provider when primary fails with billing error", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async () => {
            throw new FailoverError("billing issue", {
              reason: "billing",
              provider: "primary",
              status: 402,
            });
          },
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["fallback"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "fallback",
      result: { query: "test", provider: "fallback" },
    });
  });

  it("throws immediately on non-retryable errors without trying fallback", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async () => {
            throw new FailoverError("auth error", {
              reason: "auth",
              provider: "primary",
              status: 401,
            });
          },
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["fallback"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).rejects.toThrow("auth error");
  });

  it("skips configured fallbacks when primary succeeds", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "primary" }),
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["fallback"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "primary",
      result: { query: "test", provider: "primary" },
    });
  });

  it("deduplicates providers in fallback chain", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "primary" }),
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    // primary is also in fallbacks list - should only be tried once
    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["fallback", "primary"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "primary",
      result: { query: "test", provider: "primary" },
    });
  });

  it("validates explicit providerId and throws for unknown provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "primary" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "typo-provider",
        args: { query: "test" },
      }),
    ).rejects.toThrow('Unknown web_search provider "typo-provider".');
  });

  it("honors preferRuntimeProviders during fallback resolution", async () => {
    const bundledProvider = createProvider({
      pluginId: "bundled-search",
      id: "bundled",
      credentialPath: "tools.web.search.bundled.apiKey",
      autoDetectOrder: 1,
      getCredentialValue: () => "bundled-configured",
      createTool: () => ({
        description: "bundled",
        parameters: {},
        execute: async (args) => ({ ...args, provider: "bundled" }),
      }),
    });
    const runtimeProvider = createProvider({
      pluginId: "runtime-search",
      id: "runtime",
      credentialPath: "",
      autoDetectOrder: 0,
      requiresCredential: false,
      createTool: () => ({
        description: "runtime",
        parameters: {},
        execute: async (args) => ({ ...args, provider: "runtime" }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([runtimeProvider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([bundledProvider]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "runtime",
        preferRuntimeProviders: false,
        args: { query: "test" },
      }),
    ).rejects.toThrow('Unknown web_search provider "runtime".');
  });

  it("normalizes mixed-case providerId and executes against resolved provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "grok-search",
        id: "grok",
        credentialPath: "tools.web.search.grok.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "grok-configured",
        createTool: () => ({
          description: "grok",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "grok" }),
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "Grok",
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "grok",
      result: { query: "test", provider: "grok" },
    });
  });

  it("deduplicates fallbacks by resolved provider id, not raw input id", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createProvider({
        pluginId: "primary-search",
        id: "primary",
        credentialPath: "tools.web.search.primary.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "primary-configured",
        createTool: () => ({
          description: "primary",
          parameters: {},
          execute: async () => {
            throw new FailoverError("rate limited", {
              reason: "rate_limit",
              provider: "primary",
              status: 429,
            });
          },
        }),
      }),
      createProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "tools.web.search.fallback.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "fallback-configured",
        createTool: () => ({
          description: "fallback",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "fallback" }),
        }),
      }),
    ]);

    // "typo" is unknown — skip it. "primary" resolves to primary (already tried),
    // so it is correctly deduplicated. "fallback" is a new provider and is added.
    // Primary fails with rate_limit, loop continues to fallback and succeeds.
    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "primary",
                fallbacks: ["typo", "fallback"],
              },
            },
          },
        },
        args: { query: "test" },
      }),
    ).resolves.toEqual({
      provider: "fallback",
      result: { query: "test", provider: "fallback" },
    });
  });

});
