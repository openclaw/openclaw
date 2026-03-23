import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { runWebSearch } from "./runtime.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

describe("web search runtime", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("executes searches through the active plugin registry", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        credentialPath: "tools.web.search.custom.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

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
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        getConfiguredCredentialValue: (config) => {
          const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
            | TestPluginWebSearchConfig
            | undefined;
          return pluginConfig?.webSearch?.apiKey;
        },
        setConfiguredCredentialValue: (configTarget, value) => {
          configTarget.plugins = {
            ...configTarget.plugins,
            entries: {
              ...configTarget.plugins?.entries,
              "custom-search": {
                enabled: true,
                config: { webSearch: { apiKey: value } },
              },
            },
          };
        },
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

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

  it("falls back to a keyless provider when no credentials are available", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "duckduckgo",
      pluginName: "DuckDuckGo",
      provider: {
        id: "duckduckgo",
        label: "DuckDuckGo Search",
        hint: "Keyless fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        credentialPath: "",
        autoDetectOrder: 100,
        getCredentialValue: () => "duckduckgo-no-key-needed",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "duckduckgo",
          parameters: {},
          execute: async (args) => ({ ...args, provider: "duckduckgo" }),
        }),
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

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
});
