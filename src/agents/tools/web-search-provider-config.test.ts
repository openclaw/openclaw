import { describe, expect, it } from "vitest";
import {
  createScopedPluginWebSearchCredentialAccessors,
  type WebSearchConfig,
} from "./web-search-provider-config.js";

describe("createScopedPluginWebSearchCredentialAccessors", () => {
  it("uses the plugin id as the default scoped config key", () => {
    const accessors = createScopedPluginWebSearchCredentialAccessors({ pluginId: "perplexity" });
    const searchConfigTarget: Record<string, unknown> = {};
    const configTarget = {} as {
      tools?: { web?: { search?: WebSearchConfig } };
      plugins?: Record<string, unknown>;
    };

    accessors.setCredentialValue(searchConfigTarget, "pplx-test");
    accessors.setConfiguredCredentialValue(configTarget, "pplx-configured");

    expect(accessors.credentialPath).toBe("plugins.entries.perplexity.config.webSearch.apiKey");
    expect(accessors.inactiveSecretPaths).toEqual([
      "plugins.entries.perplexity.config.webSearch.apiKey",
    ]);
    expect(accessors.getCredentialValue(searchConfigTarget)).toBe("pplx-test");
    expect(accessors.getConfiguredCredentialValue(configTarget)).toBe("pplx-configured");
    expect(configTarget.plugins).toMatchObject({
      entries: {
        perplexity: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: "pplx-configured",
            },
          },
        },
      },
    });
  });

  it("supports distinct plugin and scoped config ids", () => {
    const accessors = createScopedPluginWebSearchCredentialAccessors({
      pluginId: "xai",
      searchConfigKey: "grok",
    });
    const searchConfigTarget: Record<string, unknown> = {};
    const configTarget = {} as {
      tools?: { web?: { search?: WebSearchConfig } };
      plugins?: Record<string, unknown>;
    };

    accessors.setCredentialValue(searchConfigTarget, "xai-scoped");
    accessors.setConfiguredCredentialValue(configTarget, "xai-configured");

    expect(searchConfigTarget).toEqual({
      grok: {
        apiKey: "xai-scoped",
      },
    });
    expect(accessors.getConfiguredCredentialValue(configTarget)).toBe("xai-configured");
    expect(configTarget.plugins).toMatchObject({
      entries: {
        xai: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: "xai-configured",
            },
          },
        },
      },
    });
  });
});
