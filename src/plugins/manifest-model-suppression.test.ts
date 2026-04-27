import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

import {
  clearManifestModelSuppressionCacheForTest,
  resolveManifestBuiltInModelSuppression,
} from "./manifest-model-suppression.js";

describe("manifest model suppression", () => {
  beforeEach(() => {
    clearManifestModelSuppressionCacheForTest();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "openai",
          providers: ["openai"],
          modelCatalog: {
            aliases: {
              "azure-openai-responses": {
                provider: "openai",
              },
            },
            suppressions: [
              {
                provider: "azure-openai-responses",
                model: "gpt-5.3-codex-spark",
                reason: "Use openai/gpt-5.5.",
              },
              {
                provider: "openrouter",
                model: "foreign-row",
              },
            ],
          },
        },
      ],
    });
  });

  it("resolves manifest suppressions for declared provider aliases", () => {
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "azure-openai-responses",
        id: "GPT-5.3-Codex-Spark",
        env: process.env,
      }),
    ).toEqual({
      suppress: true,
      errorMessage:
        "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. Use openai/gpt-5.5.",
    });
  });

  it("ignores suppressions for providers the plugin does not own", () => {
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "openrouter",
        id: "foreign-row",
        env: process.env,
      }),
    ).toBeUndefined();
  });

  it("caches planned manifest suppressions per config and environment", () => {
    const config = { plugins: { entries: { openai: { enabled: true } } } };

    resolveManifestBuiltInModelSuppression({
      provider: "azure-openai-responses",
      id: "gpt-5.3-codex-spark",
      config,
      env: process.env,
    });
    resolveManifestBuiltInModelSuppression({
      provider: "azure-openai-responses",
      id: "gpt-5.3-codex-spark",
      config,
      env: process.env,
    });

    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
  });
});
