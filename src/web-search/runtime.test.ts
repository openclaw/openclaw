import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { runWebSearch } from "./runtime.js";

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
});
