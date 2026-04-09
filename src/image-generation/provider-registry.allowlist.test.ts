import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createEmptyProviderRegistryAllowlistFallbackRegistry,
  getProviderRegistryAllowlistMocks,
  installProviderRegistryAllowlistMockDefaults,
} from "../test-utils/provider-registry-allowlist.test-helpers.js";

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;
const mocks = getProviderRegistryAllowlistMocks();
installProviderRegistryAllowlistMockDefaults();

describe("image-generation provider registry allowlist fallback", () => {
  beforeAll(async () => {
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("adds bundled capability plugin ids to plugins.allow before fallback registry load", () => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const compatConfig = {
      plugins: {
        allow: ["custom-plugin", "openai"],
        entries: { openai: { enabled: true } },
      },
    };

    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          contracts: { imageGenerationProviders: ["openai"] },
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation(() =>
      createEmptyProviderRegistryAllowlistFallbackRegistry(),
    );

    expect(listImageGenerationProviders(cfg)).toEqual([]);
    expect(getImageGenerationProvider("openai", cfg)).toBeUndefined();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: compatConfig,
    });
  });
});
