import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

const runWebSearchCalls = vi.hoisted(
  () => [] as Array<{ config?: unknown; runtimeWebSearch?: unknown }>,
);

const resolveManifestContractOwnerPluginIdMock = vi.hoisted(() =>
  vi.fn<
    (params: {
      contract: string;
      value?: string;
      origin?: string;
      config?: unknown;
    }) => string | undefined
  >(() => undefined),
);

vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/plugin-registry.js")>();
  return {
    ...actual,
    resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
  };
});

vi.mock("../../web-search/runtime.js", async () => {
  const { getActivePluginRegistry } = await import("../../plugins/runtime.js");
  const { getActiveRuntimeWebToolsMetadata } =
    await import("../../secrets/runtime-web-tools-state.js");
  const resolveRuntimeDefinition = (options?: {
    config?: unknown;
    runtimeWebSearch?: { selectedProvider?: string; providerConfigured?: string };
  }) => {
    const providerId =
      options?.runtimeWebSearch?.selectedProvider ??
      options?.runtimeWebSearch?.providerConfigured ??
      getActiveRuntimeWebToolsMetadata()?.search?.selectedProvider ??
      getActiveRuntimeWebToolsMetadata()?.search?.providerConfigured;
    const registration = getActivePluginRegistry()?.webSearchProviders.find(
      (entry) => entry.provider.id === providerId,
    );
    const definition = registration?.provider.createTool({
      config: options?.config as never,
      runtimeMetadata: options?.runtimeWebSearch as never,
    });
    return registration && definition
      ? {
          provider: {
            ...registration.provider,
            pluginId: registration.pluginId,
          },
          definition,
        }
      : null;
  };
  return {
    resolveWebSearchDefinition: resolveRuntimeDefinition,
    resolveWebSearchProviderId: () => "",
    runWebSearch: async (options: {
      config?: unknown;
      args: Record<string, unknown>;
      runtimeWebSearch?: unknown;
    }) => {
      runWebSearchCalls.push({
        config: options.config,
        runtimeWebSearch: options.runtimeWebSearch,
      });
      const resolved = resolveRuntimeDefinition(options as never);
      if (!resolved) {
        throw new Error("web_search is disabled or no provider is available.");
      }
      return {
        provider: resolved.provider.id,
        result: await resolved.definition.execute(options.args),
      };
    },
  };
});

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
  clearRuntimeConfigSnapshot();
  runWebSearchCalls.length = 0;
  resolveManifestContractOwnerPluginIdMock.mockReset();
  resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
  clearRuntimeConfigSnapshot();
});

describe("web tools defaults", () => {
  it("enables web_fetch by default (non-sandbox)", () => {
    const tool = createWebFetchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("web_fetch");
  });

  it("disables web_fetch when explicitly disabled", () => {
    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { enabled: false } } } },
      sandboxed: false,
    });
    expect(tool).toBeNull();
  });

  it("uses runtime-only web_search providers when runtime metadata is present", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      source: "test",
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
          description: "custom runtime tool",
          parameters: {},
          execute: async () => ({ ok: true }),
        }),
      },
    });
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      sandboxed: true,
      runtimeWebSearch: {
        providerConfigured: "custom",
        providerSource: "configured",
        selectedProvider: "custom",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    const result = await tool?.execute?.("call-runtime-provider", {});

    expect(tool?.description).toContain("Search the web");
    expect(result?.details).toMatchObject({ ok: true });
  });

  it("late-binds managed web_search execution to the current runtime snapshot", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push(
      {
        pluginId: "stale-search",
        pluginName: "Stale Search",
        source: "test",
        provider: {
          id: "stale",
          label: "Stale Search",
          hint: "Stale runtime provider",
          envVars: [],
          placeholder: "stale-...",
          signupUrl: "https://example.com/stale",
          autoDetectOrder: 1,
          credentialPath: "tools.web.search.stale.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => ({
            description: "stale runtime tool",
            parameters: {},
            execute: async () => ({ provider: "stale" }),
          }),
        },
      },
      {
        pluginId: "fresh-search",
        pluginName: "Fresh Search",
        source: "test",
        provider: {
          id: "fresh",
          label: "Fresh Search",
          hint: "Fresh runtime provider",
          envVars: [],
          placeholder: "fresh-...",
          signupUrl: "https://example.com/fresh",
          autoDetectOrder: 2,
          credentialPath: "tools.web.search.fresh.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => ({
            description: "fresh runtime tool",
            parameters: {},
            execute: async () => ({ provider: "fresh" }),
          }),
        },
      },
    );
    setActivePluginRegistry(registry);
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "fresh",
        providerSource: "configured",
        selectedProvider: "fresh",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "stale" } } } },
      sandboxed: true,
      runtimeWebSearch: {
        providerConfigured: "stale",
        providerSource: "configured",
        selectedProvider: "stale",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      lateBindRuntimeConfig: true,
    });

    const result = await tool?.execute?.("call-runtime-provider", {});

    expect(result?.details).toMatchObject({ provider: "fresh" });
    expect(runWebSearchCalls).toHaveLength(1);
    expect(runWebSearchCalls[0]?.config).toBeUndefined();
    expect(runWebSearchCalls[0]?.runtimeWebSearch).toMatchObject({
      selectedProvider: "fresh",
    });
  });

  it("resolves the bundled-plugin owner using the runtime snapshot when late-binding", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "brave",
      pluginName: "Brave",
      source: "test",
      provider: {
        id: "brave",
        label: "Brave",
        hint: "Brave runtime provider",
        envVars: ["BRAVE_API_KEY"],
        placeholder: "brave-...",
        signupUrl: "https://example.com/brave",
        autoDetectOrder: 1,
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "brave runtime tool",
          parameters: {},
          execute: async () => ({ provider: "brave" }),
        }),
      },
    });
    setActivePluginRegistry(registry);
    const runtimeConfig = {
      tools: { web: { search: { provider: "brave" } } },
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: { webSearch: { apiKey: "resolved-brave-key" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, runtimeConfig);
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "brave",
        providerSource: "configured",
        selectedProvider: "brave",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });

    const tool = createWebSearchTool({
      lateBindRuntimeConfig: true,
    });

    const result = await tool?.execute?.("call-bundled-owner-lookup", {});

    expect(result?.details).toMatchObject({ provider: "brave" });
    const ownerLookups = resolveManifestContractOwnerPluginIdMock.mock.calls;
    expect(ownerLookups.length).toBeGreaterThan(0);
    // Regression guard: pre-fix, the lateBind path passed `config: undefined`,
    // leaving the bundled owner lookup unable to resolve the runtime-configured
    // provider for sub-agent sessions whose active plugin registry has been
    // narrowed by the tool allowlist. The fix late-binds the owner-lookup config
    // to the active runtime snapshot so bundled providers stay resolvable.
    const lateBindLookup = ownerLookups.find(([call]) => call?.value === "brave");
    expect(lateBindLookup).toBeDefined();
    expect(lateBindLookup?.[0]?.config).toBe(runtimeConfig);
  });
});
