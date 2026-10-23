import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authSource from "../agents/auth-profiles/source-check.js";
import type { OpenClawConfig } from "../config/config.js";
import type * as Registry from "../plugins/plugin-registry-contributions.js";
import type { WebSearchProviderToolDefinition } from "../plugins/web-provider-types.js";
import type * as Providers from "../plugins/web-search-providers.runtime.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

// mock-isolation: Synthetic ownership/providers avoid installed plugins and machine discovery.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
const { ownerMock, pluginProvidersMock, runtimeProvidersMock } = vi.hoisted(() => ({
  ownerMock: vi.fn<typeof Registry.resolveManifestContractOwnerPluginId>(),
  pluginProvidersMock: vi.fn<typeof Providers.resolvePluginWebSearchProviders>(),
  runtimeProvidersMock: vi.fn<typeof Providers.resolveRuntimeWebSearchProviders>(),
}));
// mock-isolation: Synthetic manifest owners keep installed plugin state out of provider selection.
vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: ownerMock,
}));
// mock-isolation: Fixture providers exercise search execution without loading installed plugins.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: pluginProvidersMock,
  resolveRuntimeWebSearchProviders: runtimeProvidersMock,
}));

const selected = (provider: string): OpenClawConfig => ({
  tools: { web: { search: { provider } } },
});
const tool = (execute: WebSearchProviderToolDefinition["execute"]) => ({
  description: "search",
  parameters: {},
  execute,
});
function customConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: { entries: { "custom-search": { enabled: true, config: { webSearch: { apiKey } } } } },
  };
}
function customProvider(overrides: Partial<WebSearchTestProviderParams> = {}) {
  return createWebSearchTestProvider({
    pluginId: "custom-search",
    id: "custom",
    autoDetectOrder: 1,
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    getConfiguredCredentialValue: customKey,
    createTool: () => tool(async (args) => ({ ...args, ok: true })),
    ...overrides,
  });
}
function customKey(config?: OpenClawConfig): unknown {
  const entry = config?.plugins?.entries?.["custom-search"]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return entry?.webSearch?.apiKey;
}
function searchProvider(
  id: "google" | "duckduckgo",
  overrides: Partial<WebSearchTestProviderParams> = {},
) {
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
const unavailable = "web_search is disabled or no provider is available.";

describe("web search runtime", () => {
  let hasUsableWebSearchProvider: typeof import("./runtime.js").hasUsableWebSearchProvider;
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
  let setRuntimeConfigSnapshot: typeof import("../config/runtime-snapshot.js").setRuntimeConfigSnapshot;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const search = (options: Omit<Parameters<typeof runWebSearch>[0], "args"> = {}) =>
    runWebSearch({ config: {}, ...options, args: { query: "hello" } });
  const result = (provider: string, fields: Record<string, unknown> = { provider }) => ({
    provider,
    result: { query: "hello", ...fields },
  });
  function useCustom(overrides: Partial<WebSearchTestProviderParams> = {}) {
    const provider = customProvider(overrides);
    runtimeProvidersMock.mockReturnValue([provider]);
    pluginProvidersMock.mockReturnValue([provider]);
  }
  function publishOAuth(agentDir: string) {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createOAuthAuthProfileStore({
          provider: "xai",
          profileId: "xai:default",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
        }),
      },
    ]);
    useCustom({
      pluginId: "xai",
      id: "grok",
      authProviderId: "xai",
      credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    });
  }
  beforeAll(async () => {
    ({ hasUsableWebSearchProvider, runWebSearch } = await import("./runtime.js"));
    ({ clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ setRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
  });
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    ownerMock.mockReset().mockReturnValue(undefined);
    pluginProvidersMock.mockReset().mockReturnValue([]);
    runtimeProvidersMock.mockReset().mockReturnValue([]);
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  describe("OAuth and environment auto-detection", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("executes explicitly selected plugins without opening their auth sources", async () => {
      using sourceProbe = vi
        .spyOn(authSource, "hasAnyAuthProfileStoreSourceAsync")
        .mockRejectedValue(new Error("auth source unavailable"));
      runtimeProvidersMock.mockReturnValue([
        createWebSearchTestProvider({
          pluginId: "custom-search",
          id: "custom",
          credentialPath: "tools.web.search.custom.apiKey",
          authProviderId: "custom-auth",
        }),
      ]);
      await expect(search({ config: selected("custom") })).resolves.toEqual(result("custom"));
      expect(sourceProbe).not.toHaveBeenCalled();
    });

    it.each([
      { name: "OAuth fallback", oauth: true, pin: undefined, order: ["grok", "tavily"] },
      { name: "environment only", oauth: false, pin: undefined, order: ["tavily"] },
      { name: "explicit environment provider", oauth: true, pin: "tavily", order: ["tavily"] },
    ])("preserves $name", async ({ oauth, pin, order }) => {
      vi.stubEnv("TAVILY_API_KEY", "tavily-synthetic-key");
      const agentDir = tempDirs.make("openclaw-web-search-order-");
      publishOAuth(agentDir);
      if (!oauth) {
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir, store: { version: 1, profiles: {} } },
        ]);
      }
      const attempts: string[] = [];
      runtimeProvidersMock.mockReturnValue(
        [
          { pluginId: "xai", id: "grok", authProviderId: "xai", autoDetectOrder: 30 },
          { pluginId: "tavily", id: "tavily", autoDetectOrder: 70 },
        ].map((entry) =>
          createWebSearchTestProvider({
            ...entry,
            credentialPath: `plugins.entries.${entry.pluginId}.config.webSearch.apiKey`,
            createTool: () =>
              tool(async () => {
                attempts.push(entry.id);
                if (entry.id === "grok") {
                  throw new Error("grok search failed");
                }
                return { answer: "environment result" };
              }),
          }),
        ),
      );
      await expect(
        search({
          agentDir,
          config: pin ? selected(pin) : {},
          runtimeWebSearch: {
            providerSource: pin ? "configured" : "auto-detect",
            selectedProvider: "tavily",
            selectedProviderKeySource: "env",
            diagnostics: [],
          },
        }),
      ).resolves.toMatchObject({ provider: order.at(-1) });
      expect(attempts).toEqual(order);
    });
  });

  describe("runtime snapshots", () => {
    function activateSnapshot(
      selectedProvider: string,
      sourceConfig: OpenClawConfig = {},
      config = structuredClone(sourceConfig),
    ) {
      activateSecretsRuntimeSnapshot({
        sourceConfig,
        config,
        authStores: [],
        warnings: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
        webTools: {
          search: { providerSource: "auto-detect", selectedProvider, diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
    }
    function useConfigEcho() {
      useCustom({
        createTool: ({ config }) => tool(async (args) => ({ ...args, apiKey: customKey(config) })),
      });
    }

    it("uses the active resolved runtime config for matching source config callers", async () => {
      useConfigEcho();
      const source = customConfig({
        source: "exec",
        provider: "mockexec",
        id: "custom-search/api-key",
      });
      activateSnapshot("custom", source, customConfig("resolved-custom-key"));
      await expect(search({ config: structuredClone(source) })).resolves.toEqual(
        result("custom", { apiKey: "resolved-custom-key" }),
      );
    });

    it("can prefer an explicitly resolved input config over a pinned config snapshot", async () => {
      useConfigEcho();
      setRuntimeConfigSnapshot(
        customConfig({ source: "env", provider: "default", id: "CUSTOM_SEARCH_API_KEY" }),
      );
      await expect(
        search({
          config: customConfig("resolved-custom-key"),
          preferInputConfig: true,
          providerId: "custom",
          preferRuntimeProviders: false,
        }),
      ).resolves.toEqual(result("custom", { apiKey: "resolved-custom-key" }));
    });

    it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
      runtimeProvidersMock.mockReturnValue(
        ["alpha", "beta"].map((id, index) =>
          searchProvider("google", {
            pluginId: `${id}-search`,
            id,
            credentialPath: `tools.web.search.${id}.apiKey`,
            autoDetectOrder: index + 1,
            getConfiguredCredentialValue: () => `${id}-configured`,
            getCredentialValue: () => `${id}-configured`,
            createTool: ({ runtimeMetadata }) =>
              tool(async (args) => ({
                ...args,
                provider: id,
                runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
              })),
          }),
        ),
      );
      activateSnapshot("beta");
      await expect(search()).resolves.toEqual(
        result("beta", { provider: "beta", runtimeSelectedProvider: "beta" }),
      );
    });

    it("ignores auto-detected keyless runtime metadata when no provider is configured", async () => {
      runtimeProvidersMock.mockReturnValue([
        createWebSearchTestProvider({
          pluginId: "parallel",
          id: "parallel-free",
          credentialPath: "",
          autoDetectOrder: 76,
          requiresCredential: false,
        }),
      ]);
      activateSnapshot("parallel-free");
      await expect(search()).rejects.toThrow(unavailable);
    });

    it("ignores auto-detected runtime metadata after config names an unknown provider", async () => {
      const createTool = vi.fn(() => tool(async (args) => ({ ...args, ok: true })));
      runtimeProvidersMock.mockReturnValue([searchProvider("google", { createTool })]);
      const config = selected("missing-id");
      activateSnapshot("google", config);
      await expect(search({ config: structuredClone(config) })).rejects.toThrow(unavailable);
      expect(createTool).not.toHaveBeenCalled();
    });
  });

  it("accepts the prepared provider selection without rediscovering providers", async () => {
    expect(
      await hasUsableWebSearchProvider({
        config: {},
        preferRuntimeProviders: true,
        runtimeWebSearch: {
          providerSource: "auto-detect",
          selectedProvider: "brave",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
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
    useCustom({
      credentialPath: "tools.web.search.custom.apiKey",
      requiresCredential: false,
      createTool: () => tool(execute),
    });
    await expect(
      search({ config: selected("custom"), signal: controller.signal }),
    ).resolves.toEqual(result("custom", { aborted: false, sameSignal: true }));
    expect(execute).toHaveBeenCalledWith({ query: "hello" }, { signal: controller.signal });
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
      search({ config: customConfig("custom-config-key"), signal: controller.signal }),
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
    useCustom({
      credentialPath: "tools.web.search.custom.apiKey",
      requiresCredential: false,
      createTool: () => tool(execute),
    });
    await expect(search({ config: selected("custom"), signal: controller.signal })).rejects.toBe(
      abortReason,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["inline", "custom-config-key"],
    [
      "non-env SecretRef",
      { source: "file", provider: "vault", id: "/providers/custom-search/apiKey" },
    ],
  ])("auto-detects canonical plugin-owned %s credentials", async (_name, key) => {
    useCustom();
    await expect(search({ config: customConfig(key) })).resolves.toEqual(
      result("custom", { ok: true }),
    );
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
      search({
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
      }),
    ).resolves.toEqual(result("custom", { ok: true }));
  });

  it("auto-detects a provider from a model-provider auth profile", async () => {
    const agentDir = tempDirs.make("openclaw-web-search-auth-");
    publishOAuth(agentDir);
    await expect(
      search({ config: { agents: { entries: { main: { agentDir } } } } }),
    ).resolves.toEqual(result("grok", { ok: true }));
  });

  it("auto-detects a provider from the active agent auth profile", async () => {
    const defaultAgentDir = tempDirs.make("openclaw-web-search-default-");
    const activeAgentDir = tempDirs.make("openclaw-web-search-active-");
    publishOAuth(activeAgentDir);
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: { agentDir: defaultAgentDir }, side: { agentDir: activeAgentDir } },
      },
    } satisfies OpenClawConfig;
    expect(
      await hasUsableWebSearchProvider({
        agentDir: activeAgentDir,
        config,
        preferRuntimeProviders: true,
      }),
    ).toBe(true);
    await expect(search({ agentDir: activeAgentDir, config })).resolves.toEqual(
      result("grok", { ok: true }),
    );
  });

  it("passes the active agentDir into selected provider tools", async () => {
    const activeAgentDir = tempDirs.make("openclaw-web-search-tool-agent-");
    useCustom({
      credentialPath: "",
      requiresCredential: false,
      createTool: ({ agentDir }) => tool(async (args) => ({ ...args, agentDir })),
    });
    await expect(search({ agentDir: activeAgentDir, config: selected("custom") })).resolves.toEqual(
      result("custom", { agentDir: activeAgentDir }),
    );
  });

  it("does not auto-select keyless providers when no provider is configured", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("duckduckgo", { getCredentialValue: () => "duckduckgo-no-key-needed" }),
      createWebSearchTestProvider({
        pluginId: "parallel",
        id: "parallel-free",
        credentialPath: "",
        autoDetectOrder: 76,
        requiresCredential: false,
      }),
    ]);
    await expect(search()).rejects.toThrow(unavailable);
  });

  it.each(["thrown", "structured"])(
    "falls back after an auto-selected provider's %s error",
    async (kind) => {
      runtimeProvidersMock.mockReturnValue([
        searchProvider("google", {
          createTool: () =>
            tool(async () => {
              if (kind === "thrown") {
                throw new Error("google aborted");
              }
              return { error: "missing_google_api_key", message: "google key missing" };
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
      await expect(search()).resolves.toEqual(result("backup"));
    },
  );

  it("does not fall back when an auto-selected provider returns a validation error payload", async () => {
    const payload = {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
    };
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", { createTool: () => tool(async () => payload) }),
      searchProvider("duckduckgo"),
    ]);
    await expect(
      runWebSearch({ config: {}, args: { query: "hello", freshness: "forever" } }),
    ).resolves.toEqual({ provider: "google", result: payload });
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
    await expect(search()).resolves.toEqual(result("google"));
  });

  it.each(["config", "caller"])(
    "does not fall back after explicit %s selection",
    async (source) => {
      runtimeProvidersMock.mockReturnValue([
        searchProvider("google", {
          createTool: () =>
            tool(async () => {
              throw new Error("google aborted");
            }),
        }),
        searchProvider("duckduckgo"),
      ]);
      await expect(
        search(source === "config" ? { config: selected("google") } : { providerId: "google" }),
      ).rejects.toThrow("google aborted");
    },
  );

  it("scopes runtime provider loading to the configured bundled web_search provider", async () => {
    ownerMock.mockImplementation(({ value }) =>
      value === "duckduckgo" ? "duckduckgo" : undefined,
    );
    runtimeProvidersMock.mockReturnValue([searchProvider("duckduckgo")]);
    await expect(search({ config: selected("duckduckgo") })).resolves.toEqual(result("duckduckgo"));
    const ownerCall = ownerMock.mock.calls[0]?.[0];
    expect(ownerCall).toMatchObject({ contract: "webSearchProviders", value: "duckduckgo" });
    expect(ownerCall).not.toHaveProperty("origin");
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["duckduckgo"]);
  });

  it("scopes runtime provider loading through manifest ownership when provider id differs from plugin id", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "gemini" ? "google" : undefined));
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", { id: "gemini", pluginId: "google" }),
    ]);
    expect(
      (
        await search({
          runtimeWebSearch: {
            providerConfigured: "gemini",
            selectedProvider: "gemini",
            providerSource: "configured",
            diagnostics: [],
          },
        })
      ).provider,
    ).toBe("gemini");
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["google"]);
  });

  it("scopes configured global web_search providers when runtime providers are not preferred", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "custom" ? "custom-search" : undefined));
    pluginProvidersMock.mockReturnValue([customProvider()]);
    await expect(
      search({
        config: { ...selected("custom"), ...customConfig("custom-key") },
        preferRuntimeProviders: false,
      }),
    ).resolves.toMatchObject({ provider: "custom" });
    expect(pluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["custom-search"] }),
    );
  });

  it("keeps runtime provider loading unscoped when configured provider ownership is unknown", async () => {
    runtimeProvidersMock.mockReturnValue([
      customProvider({
        id: "external-search",
        pluginId: "external-search",
        requiresCredential: false,
      }),
    ]);
    expect((await search({ config: selected("external-search") })).provider).toBe(
      "external-search",
    );
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toBeUndefined();
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", { createTool: () => null }),
      searchProvider("duckduckgo"),
    ]);
    await expect(search({ providerId: "google" })).rejects.toThrow(
      'web_search provider "google" is not available.',
    );
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    runtimeProvidersMock.mockReturnValue([searchProvider("google"), searchProvider("duckduckgo")]);
    await expect(search({ providerId: "missing-id" })).rejects.toThrow(
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
    await expect(search({ config: selected("missing-id") })).rejects.toThrow(unavailable);
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
      search({
        config: selected("google"),
        preferRuntimeProviders: false,
        runtimeWebSearch: {
          providerConfigured: "runtime-search",
          selectedProvider: "runtime-search",
          providerSource: "configured",
          diagnostics: [],
        },
      }),
    ).resolves.toEqual(result("google"));
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    runtimeProvidersMock.mockReturnValue([
      searchProvider("google", { createTool: () => null }),
      searchProvider("duckduckgo", { createTool: () => null }),
    ]);
    await expect(search()).rejects.toThrow(
      "web_search is enabled but no provider is currently available.",
    );
  });
});
