import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  loadPluginManifestRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("../plugins/bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;

describe("image-generation provider registry allowlist fallback", () => {
  beforeAll(async () => {
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  beforeEach(() => {
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginVitestCompat.mockReset();
    mocks.withBundledPluginVitestCompat.mockImplementation(({ config }) => config);
  });

  it("honors explicit allowlists when fallback loading bundled providers", () => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const compatConfig = {
      plugins: {
        allow: ["custom-plugin"],
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
    mocks.resolveRuntimePluginRegistry.mockImplementation(() => createEmptyPluginRegistry());

    expect(listImageGenerationProviders(cfg)).toEqual([]);
    expect(getImageGenerationProvider("openai", cfg)).toBeUndefined();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: compatConfig,
    });
  });
});
