import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/config.js";
import type * as Registry from "../plugins/plugin-registry-contributions.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/web-provider-types.js";
import type * as Providers from "../plugins/web-search-providers.runtime.js";
// mock-isolation: Use fixed discovery policy without opening machine state for provider fixtures.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

const { ownerMock, pluginProvidersMock, runtimeProvidersMock } = vi.hoisted(() => ({
  ownerMock: vi.fn<typeof Registry.resolveManifestContractOwnerPluginId>(),
  pluginProvidersMock: vi.fn<typeof Providers.resolvePluginWebSearchProviders>(),
  runtimeProvidersMock: vi.fn<typeof Providers.resolveRuntimeWebSearchProviders>(),
}));

// mock-isolation: Provider selection uses fixture ownership without loading installed plugins.
vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: ownerMock,
}));

// mock-isolation: Supply synthetic providers without admitting the operator's plugin runtime.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: pluginProvidersMock,
  resolveRuntimeWebSearchProviders: runtimeProvidersMock,
}));

function customTool() {
  return {
    description: "custom",
    parameters: {},
    execute: async (args: Record<string, unknown>) => ({ ...args, ok: true }),
  };
}

function getCustomSearchApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function customProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "custom-search",
    id: "custom",
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    autoDetectOrder: 1,
    getConfiguredCredentialValue: getCustomSearchApiKey,
    createTool: customTool,
    ...overrides,
  });
}

function customConfig(apiKey: unknown): OpenClawConfig {
  const entry = { enabled: true, config: { webSearch: { apiKey } } };
  return { plugins: { entries: { "custom-search": entry } } };
}

function searchProvider(
  id: "google" | "duckduckgo",
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: id,
    id,
    credentialPath: id === "google" ? "tools.web.search.google.apiKey" : "",
    autoDetectOrder: id === "google" ? 1 : 100,
    requiresCredential: id === "google" ? undefined : false,
    getConfiguredCredentialValue: id === "google" ? () => "configured" : undefined,
    getCredentialValue: id === "google" ? () => "configured" : undefined,
    ...overrides,
  });
}

describe("web search runtime", () => {
  let hasUsableWebSearchProvider: typeof import("./runtime.js").hasUsableWebSearchProvider;
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
  const tempDirs: string[] = [];

  function search(query: string, options: Omit<Parameters<typeof runWebSearch>[0], "args"> = {}) {
    return runWebSearch({ config: {}, ...options, args: { query } });
  }

  function tool(execute: WebSearchProviderToolDefinition["execute"]) {
    return { description: "search", parameters: {}, execute };
  }

  beforeAll(async () => {
    ({ hasUsableWebSearchProvider, runWebSearch } = await import("./runtime.js"));
    ({ clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    ownerMock.mockReset();
    pluginProvidersMock.mockReset();
    runtimeProvidersMock.mockReset();
    ownerMock.mockReturnValue(undefined);
    pluginProvidersMock.mockReturnValue([]);
    runtimeProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes searches through the active plugin registry", async () => {
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        requiresCredential: false,
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "custom",
              },
            },
          },
        },
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
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
    expect(runtimeProvidersMock).not.toHaveBeenCalled();
    expect(pluginProvidersMock).not.toHaveBeenCalled();
  });

  it("passes the run abort signal to provider execution", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => ({
        ...args,
        aborted: context?.signal?.aborted ?? false,
        sameSignal: context?.signal === controller.signal,
      }),
    );
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        requiresCredential: false,
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute,
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "custom",
              },
            },
          },
        },
        args: { query: "abort plumbing" },
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "abort plumbing", aborted: false, sameSignal: true },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: "abort plumbing" },
      { signal: controller.signal },
    );
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
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        credentialPath: "",
        createTool: () => tool(firstExecute),
      }),
      customProvider({
        pluginId: "fallback-search",
        id: "fallback",
        credentialPath: "",
        autoDetectOrder: 2,
        getConfiguredCredentialValue: () => "configured",
        createTool: () => tool(fallbackExecute),
      }),
    ]);

    await expect(
      search("abort fallback", {
        config: customConfig("custom-config-key"),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(firstExecute).toHaveBeenCalledOnce();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it("rejects a provider result that completes after parent cancellation", async () => {
    const controller = new AbortController();
    const abortReason = new Error("parent run cancelled");
    abortReason.name = "AbortError";
    const execute = vi.fn(async () => {
      controller.abort(abortReason);
      return { ok: true };
    });
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        requiresCredential: false,
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute,
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: { web: { search: { provider: "custom" } } },
        },
        args: { query: "late abort" },
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("auto-detects a provider from canonical plugin-owned credentials", async () => {
    const provider = customProvider();
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider]);

    const config = customConfig("custom-config-key");

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

  it("auto-detects a provider from a configured credential fallback", async () => {
    const provider = customProvider({
      getConfiguredCredentialFallback: (config) => {
        const modelProvider = config?.models?.providers?.["custom-search"];
        return modelProvider && typeof modelProvider === "object" && "apiKey" in modelProvider
          ? {
              path: "models.providers.custom-search.apiKey",
              value: (modelProvider as { apiKey?: unknown }).apiKey,
            }
          : undefined;
      },
    });
    runtimeProvidersMock.mockReturnValue([provider, searchProvider("duckduckgo")]);
    pluginProvidersMock.mockReturnValue([provider, searchProvider("duckduckgo")]);

    await expect(
      runWebSearch({
        config: {
          models: {
            providers: {
              "custom-search": {
                apiKey: "custom-provider-key",
                baseUrl: "https://custom-search.example/v1",
                models: [],
              },
            },
          },
        },
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "fallback", ok: true },
    });
  });

  it("auto-detects a provider from a model-provider auth profile", async () => {
    const agentDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-web-search-auth-"));
    tempDirs.push(agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createOAuthAuthProfileStore({
          provider: "xai",
          profileId: "xai:default",
          access: "xai-oauth-access-token",
          refresh: "xai-oauth-refresh-token",
        }),
      },
    ]);

    const provider = customProvider({
      pluginId: "xai",
      id: "grok",
      authProviderId: "xai",
      credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    });
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider, searchProvider("duckduckgo")]);

    await expect(
      runWebSearch({
        config: {
          agents: {
            entries: { main: { agentDir } },
          },
        },
        args: { query: "oauth-backed web search" },
      }),
    ).resolves.toEqual({
      provider: "grok",
      result: { query: "oauth-backed web search", ok: true },
    });
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

    const provider = customProvider({
      pluginId: "xai",
      id: "grok",
      authProviderId: "xai",
      credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    });
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider, searchProvider("duckduckgo")]);
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
      search("active-agent oauth-backed web search", {
        agentDir: activeAgentDir,
        config,
      }),
    ).resolves.toEqual({
      provider: "grok",
      result: { query: "active-agent oauth-backed web search", ok: true },
    });
  });

  it("passes the active agentDir into selected provider tools", async () => {
    const activeAgentDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-web-search-tool-agent-"));
    tempDirs.push(activeAgentDir);
    const provider = customProvider({
      credentialPath: "",
      requiresCredential: false,
      createTool: ({ agentDir }) => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({
          ...args,
          agentDir,
        }),
      }),
    });
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider]);

    await expect(
      runWebSearch({
        agentDir: activeAgentDir,
        config: {
          tools: {
            web: {
              search: {
                provider: "custom",
              },
            },
          },
        },
        args: { query: "active-agent tool context" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "active-agent tool context", agentDir: activeAgentDir },
    });
  });

  it("treats non-env SecretRefs as configured credentials for provider auto-detect", async () => {
    const provider = customProvider();
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider]);

    const config = customConfig({
      source: "file",
      provider: "vault",
      id: "/providers/custom-search/apiKey",
    });

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

  it("does not auto-select keyless providers when no provider is configured", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("duckduckgo", {
        getCredentialValue: () => "duckduckgo-no-key-needed",
      }),
      createWebSearchTestProvider({
        pluginId: "parallel",
        id: "parallel-free",
        credentialPath: "",
        autoDetectOrder: 76,
        requiresCredential: false,
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback" },
      }),
    ).rejects.toThrow("web_search is disabled or no provider is available.");
  });

  it("uses a keyless provider when the user explicitly selects it", async () => {
    runtimeProvidersMock.mockReturnValue([searchProvider("duckduckgo")]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "duckduckgo",
              },
            },
          },
        },
        args: { query: "explicit-keyless" },
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { query: "explicit-keyless", provider: "duckduckgo" },
    });
  });

  it("falls back to another provider when auto-selected search execution fails", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
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
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "backup",
      result: { query: "fallback", provider: "backup" },
    });
  });

  it("falls back when an auto-selected provider returns a structured error payload", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () =>
          tool(async () => ({
            error: "missing_google_api_key",
            message: "google key missing",
          })),
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

    await expect(search("fallback-structured-error")).resolves.toEqual({
      provider: "backup",
      result: { query: "fallback-structured-error", provider: "backup" },
    });
  });

  it("does not fall back when an auto-selected provider returns a validation error payload", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => ({
            error: "invalid_freshness",
            message: "freshness must be day, week, month, or year.",
          }),
        }),
      }),
      searchProvider("duckduckgo"),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback-validation-error", freshness: "forever" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: {
        error: "invalid_freshness",
        message: "freshness must be day, week, month, or year.",
      },
    });
  });

  it("does not prebuild fallback provider tools before attempting the selected provider", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google"),
      createWebSearchTestProvider({
        pluginId: "broken-fallback",
        id: "broken-fallback",
        credentialPath: "",
        autoDetectOrder: 100,
        requiresCredential: false,
        createTool: () => {
          throw new Error("fallback createTool exploded");
        },
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "selected-first" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { query: "selected-first", provider: "google" },
    });
  });

  it("does not fall back when the provider came from explicit config selection", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
        }),
      }),
      searchProvider("duckduckgo"),
    ]);

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
        args: { query: "configured" },
      }),
    ).rejects.toThrow("google aborted");
  });

  it("scopes runtime provider loading to the configured bundled web_search provider", async () => {
    ownerMock.mockImplementation(({ value }) =>
      value === "duckduckgo" ? "duckduckgo" : undefined,
    );
    runtimeProvidersMock.mockReturnValue([searchProvider("duckduckgo")]);

    const result = await runWebSearch({
      config: {
        tools: {
          web: {
            search: {
              provider: "duckduckgo",
            },
          },
        },
      },
      args: { query: "configured-duck" },
    });
    expect(result.provider).toBe("duckduckgo");

    const ownerCall = ownerMock.mock.calls[0]?.[0];
    expect(ownerCall?.contract).toBe("webSearchProviders");
    expect(ownerCall?.value).toBe("duckduckgo");
    expect(ownerCall).not.toHaveProperty("origin");
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["duckduckgo"]);
  });

  it("scopes runtime provider loading through manifest ownership when provider id differs from plugin id", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "gemini" ? "google" : undefined));
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        id: "gemini",
        pluginId: "google",
      }),
    ]);

    const result = await search("configured-gemini", {
      runtimeWebSearch: {
        providerConfigured: "gemini",
        selectedProvider: "gemini",
        providerSource: "configured",
        diagnostics: [],
      },
    });
    expect(result.provider).toBe("gemini");

    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["google"]);
  });

  it("scopes configured global web_search providers when runtime providers are not preferred", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "custom" ? "custom-search" : undefined));
    pluginProvidersMock.mockReturnValue([customProvider()]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "custom",
              },
            },
          },
          ...customConfig("custom-key"),
        },
        preferRuntimeProviders: false,
        args: { query: "configured-custom" },
      }),
    ).resolves.toMatchObject({
      provider: "custom",
    });

    expect(pluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["custom-search"],
      }),
    );
  });

  it("keeps runtime provider loading unscoped when configured provider ownership is unknown", async () => {
    ownerMock.mockReturnValue(undefined);
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        id: "external-search",
        pluginId: "external-search",
        requiresCredential: false,
      }),
    ]);

    const result = await runWebSearch({
      config: {
        tools: {
          web: {
            search: {
              provider: "external-search",
            },
          },
        },
      },
      args: { query: "external-provider" },
    });
    expect(result.provider).toBe("external-search");

    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toBeUndefined();
  });

  it("does not fall back when the caller explicitly selects a provider", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
        }),
      }),
      searchProvider("duckduckgo"),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "google",
        args: { query: "explicit" },
      }),
    ).rejects.toThrow("google aborted");
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => null,
      }),
      searchProvider("duckduckgo"),
    ]);

    await expect(search("explicit-null-tool", { providerId: "google" })).rejects.toThrow(
      'web_search provider "google" is not available.',
    );
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    runtimeProvidersMock.mockReturnValue([searchProvider("google"), searchProvider("duckduckgo")]);

    await expect(search("explicit-missing", { providerId: "missing-id" })).rejects.toThrow(
      'Unknown web_search provider "missing-id".',
    );
  });

  it("does not fall back when config names an unknown provider id", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => {
          throw new Error("google aborted");
        },
      }),
      searchProvider("duckduckgo"),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "missing-id",
              },
            },
          },
        },
        args: { query: "config-typo" },
      }),
    ).rejects.toThrow("web_search is disabled or no provider is available.");
  });

  it("honors preferRuntimeProviders during execution", async () => {
    const configuredProvider = searchProvider("google");
    const runtimeProvider = createWebSearchTestProvider({
      pluginId: "runtime-search",
      id: "runtime-search",
      credentialPath: "",
      autoDetectOrder: 0,
      requiresCredential: false,
    });
    runtimeProvidersMock.mockReturnValue([configuredProvider, runtimeProvider]);
    pluginProvidersMock.mockReturnValue([configuredProvider]);

    await expect(
      search("prefer-config", {
        config: { tools: { web: { search: { provider: "google" } } } },
        runtimeWebSearch: {
          providerConfigured: "runtime-search",
          selectedProvider: "runtime-search",
          providerSource: "configured",
          diagnostics: [],
        },
        preferRuntimeProviders: false,
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { query: "prefer-config", provider: "google" },
    });
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", {
        createTool: () => null,
      }),
      searchProvider("duckduckgo", {
        createTool: () => null,
      }),
    ]);

    await expect(search("all-null-tools")).rejects.toThrow(
      "web_search is enabled but no provider is currently available.",
    );
  });
});
