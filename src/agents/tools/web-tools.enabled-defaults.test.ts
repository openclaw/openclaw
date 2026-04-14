import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { clearActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
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

  it("returns web_search when a keyless provider is in the active registry (enabledByDefault)", () => {
    // Simulates enabledByDefault: true loading DuckDuckGo into the active registry at startup.
    // When no config is passed, createWebSearchTool uses the active registry directly.
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "duckduckgo",
      pluginName: "DuckDuckGo",
      source: "bundled",
      provider: {
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free web search fallback with no API key required",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        autoDetectOrder: 100,
        credentialPath: "",
        inactiveSecretPaths: [],
        getCredentialValue: () => "",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "Search the web using DuckDuckGo.",
          parameters: {},
          execute: async () => ({}),
        }),
      },
    });
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool();

    expect(tool?.name).toBe("web_search");
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

    expect(tool?.description).toBe("custom runtime tool");
    expect(result?.details).toMatchObject({ ok: true });
  });
});
