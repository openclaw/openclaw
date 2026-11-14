import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authSource from "../agents/auth-profiles/source-check.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type * as Registry from "../plugins/plugin-registry-contributions.js";
import type { WebSearchProviderToolDefinition } from "../plugins/web-provider-types.js";
import type * as Providers from "../plugins/web-search-providers.runtime.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";
import { WebSearchProviderError } from "./runtime-error.js";
import { hasUsableWebSearchProvider, runWebSearch } from "./runtime.js";

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
const customConfig = (apiKey: unknown): OpenClawConfig => ({
  plugins: { entries: { "custom-search": { enabled: true, config: { webSearch: { apiKey } } } } },
});
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
function searchProvider(id: string, overrides: Partial<WebSearchTestProviderParams> = {}) {
  return createWebSearchTestProvider({
    pluginId: id,
    id,
    credentialPath: id === "duckduckgo" ? "" : `tools.web.search.${id}.apiKey`,
    autoDetectOrder: id === "google" ? 1 : 100,
    requiresCredential: id === "duckduckgo" ? false : undefined,
    getConfiguredCredentialValue: id === "duckduckgo" ? undefined : () => "configured",
    getCredentialValue: id === "duckduckgo" ? undefined : () => "configured",
    ...overrides,
  });
}
const unavailable = "web_search is disabled or no provider is available.";
const metadata = (
  selectedProvider: string,
  providerSource: RuntimeWebSearchMetadata["providerSource"] = "auto-detect",
): RuntimeWebSearchMetadata => ({ selectedProvider, providerSource, diagnostics: [] });
const failGoogle = () => {
  throw new Error("google aborted");
};

describe("web search runtime", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const search = (options: Omit<Parameters<typeof runWebSearch>[0], "args"> = {}) =>
    runWebSearch({ config: {}, ...options, args: { query: "hello" } });
  const expectSearch = (
    options: Parameters<typeof search>[0],
    provider: string,
    fields: Record<string, unknown> = { provider },
  ) =>
    expect(search(options)).resolves.toEqual({ provider, result: { query: "hello", ...fields } });
  function useProviders(...providers: ReturnType<typeof searchProvider>[]) {
    runtimeProvidersMock.mockReturnValue(providers);
  }
  function useCustom(overrides: Partial<WebSearchTestProviderParams> = {}) {
    const provider = customProvider(overrides);
    useProviders(provider);
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
      useProviders(
        createWebSearchTestProvider({
          pluginId: "custom-search",
          id: "custom",
          credentialPath: "tools.web.search.custom.apiKey",
          authProviderId: "custom-auth",
        }),
      );
      await expectSearch({ config: selected("custom") }, "custom");
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
            ...metadata("tavily", pin ? "configured" : "auto-detect"),
            selectedProviderKeySource: "env",
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
          search: metadata(selectedProvider),
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
      await expectSearch({ config: structuredClone(source) }, "custom", {
        apiKey: "resolved-custom-key",
      });
    });

    it("can prefer an explicitly resolved input config over a pinned config snapshot", async () => {
      useConfigEcho();
      setRuntimeConfigSnapshot(
        customConfig({ source: "env", provider: "default", id: "CUSTOM_SEARCH_API_KEY" }),
      );
      await expectSearch(
        {
          config: customConfig("resolved-custom-key"),
          preferInputConfig: true,
          providerId: "custom",
          preferRuntimeProviders: false,
        },
        "custom",
        { apiKey: "resolved-custom-key" },
      );
    });

    it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
      runtimeProvidersMock.mockReturnValue(
        ["alpha", "beta"].map((id, index) =>
          searchProvider(id, {
            pluginId: `${id}-search`,
            autoDetectOrder: index + 1,
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
      await expectSearch({}, "beta", { provider: "beta", runtimeSelectedProvider: "beta" });
    });

    it("ignores auto-detected keyless runtime metadata when no provider is configured", async () => {
      useProviders(searchProvider("parallel-free", { requiresCredential: false }));
      activateSnapshot("parallel-free");
      await expect(search()).rejects.toThrow(unavailable);
    });

    it("ignores auto-detected runtime metadata after config names an unknown provider", async () => {
      const createTool = vi.fn(() => tool(async (args) => ({ ...args, ok: true })));
      useProviders(searchProvider("google", { createTool }));
      const config = selected("missing-id");
      activateSnapshot("google", config);
      await expect(search({ config: structuredClone(config) })).rejects.toThrow(unavailable);
      expect(createTool).not.toHaveBeenCalled();
    });
  });

  it("accepts the prepared provider selection without rediscovering providers", async () => {
    await expect(
      hasUsableWebSearchProvider({
        config: {},
        preferRuntimeProviders: true,
        runtimeWebSearch: {
          ...metadata("brave"),
          selectedProviderKeySource: "config",
        },
      }),
    ).resolves.toBe(true);
    expect(runtimeProvidersMock).not.toHaveBeenCalled();
    expect(pluginProvidersMock).not.toHaveBeenCalled();
  });

  it("passes the active agentDir and abort signal to the selected provider", async () => {
    const controller = new AbortController();
    const agentDir = tempDirs.make("openclaw-web-search-tool-agent-");
    useCustom({
      requiresCredential: false,
      createTool: ({ agentDir: toolAgentDir }) =>
        tool(async (args, context) => ({
          ...args,
          agentDir: toolAgentDir,
          aborted: context?.signal?.aborted ?? false,
          sameSignal: context?.signal === controller.signal,
        })),
    });
    await expectSearch(
      { config: selected("custom"), agentDir, signal: controller.signal },
      "custom",
      {
        aborted: false,
        sameSignal: true,
        agentDir,
      },
    );
  });

  it("rejects a provider result that completes after parent cancellation", async () => {
    const controller = new AbortController();
    const abortReason = new Error("parent run cancelled");
    abortReason.name = "AbortError";
    useCustom({
      requiresCredential: false,
      createTool: () =>
        tool(async () => {
          controller.abort(abortReason);
          return { ok: true };
        }),
    });
    await expect(search({ config: selected("custom"), signal: controller.signal })).rejects.toBe(
      abortReason,
    );
  });

  it.each([
    ["inline", "custom-config-key"],
    [
      "non-env SecretRef",
      { source: "file", provider: "vault", id: "/providers/custom-search/apiKey" },
    ],
  ])("auto-detects canonical plugin-owned %s credentials", async (_name, key) => {
    useCustom();
    await expectSearch({ config: customConfig(key) }, "custom", { ok: true });
  });

  it("auto-detects a provider from a configured credential fallback", async () => {
    const model = {
      apiKey: "custom-provider-key",
      baseUrl: "https://custom-search.example/v1",
      models: [],
    };
    const provider = customProvider({
      getConfiguredCredentialFallback: (config) => {
        const value = config?.models?.providers?.["custom-search"]?.apiKey;
        return value ? { path: "models.providers.custom-search.apiKey", value } : undefined;
      },
    });
    useProviders(provider, searchProvider("duckduckgo"));
    await expectSearch(
      { config: { models: { providers: { "custom-search": model } } } },
      "custom",
      { ok: true },
    );
  });

  it.each([false, true])("uses agent-scoped OAuth (explicit agentDir: %s)", async (explicit) => {
    const defaultAgentDir = tempDirs.make("openclaw-web-search-default-");
    const activeAgentDir = tempDirs.make("openclaw-web-search-active-");
    const agentDir = explicit ? activeAgentDir : undefined;
    publishOAuth(agentDir ?? defaultAgentDir);
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: { agentDir: defaultAgentDir }, side: { agentDir: activeAgentDir } },
      },
    } satisfies OpenClawConfig;
    await expect(
      hasUsableWebSearchProvider({ agentDir, config, preferRuntimeProviders: true }),
    ).resolves.toBe(true);
    await expectSearch({ agentDir, config }, "grok", { ok: true });
  });

  it("does not auto-select keyless providers when no provider is configured", async () => {
    useProviders(
      searchProvider("duckduckgo", { getCredentialValue: () => "duckduckgo-no-key-needed" }),
      searchProvider("parallel-free", { requiresCredential: false }),
    );
    await expect(search()).rejects.toThrow(unavailable);
  });

  it.each(["thrown", "structured"])(
    "falls back after an auto-selected provider's %s error",
    async (kind) => {
      useProviders(
        searchProvider("google", {
          createTool: () =>
            tool(async () => {
              if (kind === "thrown") {
                throw new Error("google aborted");
              }
              return { error: "missing_google_api_key", message: "google key missing" };
            }),
        }),
        searchProvider("backup", { autoDetectOrder: 2 }),
      );
      await expectSearch({}, "backup");
    },
  );

  it("returns validation errors without building or executing fallback tools", async () => {
    const fallbackFactory = vi.fn(failGoogle);
    const payload = {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
    };
    useProviders(
      searchProvider("google", { createTool: () => tool(async () => payload) }),
      searchProvider("backup", { createTool: fallbackFactory }),
    );
    await expect(
      runWebSearch({ config: {}, args: { query: "hello", freshness: "forever" } }),
    ).resolves.toEqual({ provider: "google", result: payload });
    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it.each(["config", "caller"])(
    "does not fall back after explicit %s selection",
    async (source) => {
      useProviders(
        searchProvider("google", { createTool: () => tool(failGoogle) }),
        searchProvider("duckduckgo"),
      );
      await expect(
        search(source === "config" ? { config: selected("google") } : { providerId: "google" }),
      ).rejects.toThrow("google aborted");
    },
  );

  it("scopes runtime provider loading through manifest ownership when provider id differs from plugin id", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "gemini" ? "google" : undefined));
    useProviders(searchProvider("google", { id: "gemini", pluginId: "google" }));
    await expect(
      search({ runtimeWebSearch: metadata("gemini", "configured") }),
    ).resolves.toMatchObject({ provider: "gemini" });
    const ownerCall = ownerMock.mock.calls[0]?.[0];
    expect(ownerCall).toMatchObject({ contract: "webSearchProviders", value: "gemini" });
    expect(ownerCall).not.toHaveProperty("origin");
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["google"]);
  });

  it("keeps runtime provider loading unscoped when configured provider ownership is unknown", async () => {
    useProviders(searchProvider("external-search", { requiresCredential: false }));
    expect((await search({ config: selected("external-search") })).provider).toBe(
      "external-search",
    );
    expect(runtimeProvidersMock.mock.calls[0]?.[0]?.onlyPluginIds).toBeUndefined();
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    useProviders(
      searchProvider("google", { createTool: () => null }),
      searchProvider("duckduckgo"),
    );
    await expect(search({ providerId: "google" })).rejects.toThrow(
      'web_search provider "google" is not available.',
    );
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    useProviders(searchProvider("google"), searchProvider("duckduckgo"));
    await expect(search({ providerId: "missing-id" })).rejects.toThrow(
      'Unknown web_search provider "missing-id".',
    );
  });

  it("honors preferRuntimeProviders during execution", async () => {
    ownerMock.mockImplementation(({ value }) => (value === "google" ? "google" : undefined));
    const configuredProvider = searchProvider("google");
    const runtimeProvider = searchProvider("runtime-search", {
      autoDetectOrder: 0,
      requiresCredential: false,
    });
    useProviders(configuredProvider, runtimeProvider);
    pluginProvidersMock.mockReturnValue([configuredProvider]);
    await expectSearch(
      {
        config: selected("google"),
        preferRuntimeProviders: false,
        runtimeWebSearch: metadata("runtime-search", "configured"),
      },
      "google",
    );
    expect(pluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["google"] }),
    );
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    useProviders(
      searchProvider("google", { createTool: () => null }),
      searchProvider("duckduckgo", { createTool: () => null }),
    );
    await expect(search()).rejects.toThrow(
      "web_search is enabled but no provider is currently available.",
    );
  });
  function executeSearch(
    providers: ReturnType<typeof candidate>[],
    options: Pick<Parameters<typeof runWebSearch>[0], "signal" | "assertCurrent"> = {},
  ) {
    runtimeProvidersMock.mockReturnValue(
      providers.map((provider, autoDetectOrder) => ({ ...provider, autoDetectOrder })),
    );
    return search({
      preferInputConfig: true,
      authStore: { version: 1, profiles: {} },
      runtimeWebSearch: { providerSource: "auto-detect", diagnostics: [] },
      ...options,
    });
  }
  function candidate(id: string, execute: WebSearchProviderToolDefinition["execute"]) {
    return searchProvider(id, {
      pluginId: "fixture-search",
      credentialPath: `plugins.entries.fixture-search.config.${id}`,
      createTool: () => tool(execute),
    });
  }
  describe("web search provider execution", () => {
    it.each([
      new ToolAuthorizationError("Search is not authorized for this run"),
      new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "web-search:first",
        state: "unavailable",
        paths: [],
        refKeys: [],
        reason: "credential unavailable",
      }),
    ])("does not fall back after trusted $name preflight denial", async (failure) => {
      const fallback = vi.fn(async () => ({ results: [] }));
      const pending = executeSearch([
        candidate("first", async () => {
          throw failure;
        }),
        candidate("fallback", fallback),
      ]);
      await expect(pending).rejects.toBe(failure);
      expect(fallback).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      "retains chronology across structured and thrown errors (structured first: %s)",
      async (structuredFirst) => {
        const thrown = new Error("ordinary provider failure");
        const missingKey = vi.fn(async () => ({ error: "missing_fixture_api_key" }));
        const fail = vi.fn(async () => {
          throw thrown;
        });
        const pending = executeSearch([
          candidate("first", structuredFirst ? missingKey : fail),
          candidate("second", structuredFirst ? fail : missingKey),
        ]);
        if (structuredFirst) {
          await expect(pending).rejects.toThrow(
            'web_search provider "first" returned missing_fixture_api_key',
          );
        } else {
          await expect(pending).rejects.toMatchObject({ provider: "first", cause: thrown });
        }
        expect(missingKey).toHaveBeenCalledOnce();
        expect(fail).toHaveBeenCalledOnce();
      },
    );

    it("returns the selected provider's missing-credential payload after fallback is exhausted", async () => {
      const payload = { error: "missing_fixture_api_key", message: "set FIXTURE_KEY" };
      const failure = await executeSearch([
        candidate("first", async () => payload),
        candidate("second", async () => ({ error: "missing_other_api_key" })),
      ]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WebSearchProviderError);
      if (!(failure instanceof WebSearchProviderError)) {
        throw new Error("Expected a provider-attributed search failure");
      }
      expect(failure.toResult()).toEqual({ provider: "first", result: payload });
    });

    it("gives cancellation precedence over a saved failure and later cleanup error", async () => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const fallback = vi.fn(async () => ({ results: [] }));
      await expect(
        executeSearch(
          [
            candidate("first", async () => {
              throw new Error("first provider failure");
            }),
            candidate("second", async () => {
              controller.abort(reason);
              throw new Error("second provider cleanup failure");
            }),
            candidate("fallback", fallback),
          ],
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(fallback).not.toHaveBeenCalled();
    });

    it.each(["result", "failure", "cancelled"] as const)(
      "does not fall back or return stale work after authority ends during a provider %s",
      async (completion) => {
        const controller = new AbortController();
        const denial = new Error("search caller no longer authorized");
        const cancellation = new Error("search caller cancelled");
        let current = true;
        const fallback = vi.fn(async () => ({ results: [] }));
        const pending = executeSearch(
          [
            candidate("first", async () => {
              await Promise.resolve();
              current = false;
              if (completion === "cancelled") {
                controller.abort(cancellation);
              }
              if (completion !== "result") {
                throw new Error("provider cleanup failed");
              }
              return { results: [] };
            }),
            candidate("fallback", fallback),
          ],
          {
            signal: controller.signal,
            assertCurrent: () => {
              if (!current) {
                throw denial;
              }
            },
          },
        );
        await expect(pending).rejects.toBe(completion === "cancelled" ? cancellation : denial);
        expect(fallback).not.toHaveBeenCalled();
      },
    );

    it("starts no provider factory when the caller is already cancelled", async () => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled before search");
      controller.abort(reason);
      const createTool = vi.fn(() => tool(async () => ({})));
      await expect(
        executeSearch([searchProvider("unused", { createTool })], { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(createTool).not.toHaveBeenCalled();
    });
  });
});
