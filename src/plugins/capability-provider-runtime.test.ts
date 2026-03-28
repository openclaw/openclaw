import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn(() => createEmptyPluginRegistry()),
  loadPluginManifestRegistry: vi.fn<() => MockManifestRegistry>(() =>
    createEmptyMockManifestRegistry(),
  ),
  withBundledPluginAllowlistCompat: vi.fn(({ config }) => config),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: mocks.withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
}));

let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;

describe("resolvePluginCapabilityProviders", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetPluginRuntimeStateForTest();
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue(createEmptyPluginRegistry());
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.withBundledPluginAllowlistCompat.mockReset();
    mocks.withBundledPluginAllowlistCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginVitestCompat.mockReset();
    mocks.withBundledPluginVitestCompat.mockImplementation(({ config }) => config);
    ({ resolvePluginCapabilityProviders } = await import("./capability-provider-runtime.js"));
  });

  it("uses the active registry when capability providers are already loaded", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "OpenAI",
      source: "test",
      provider: {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    });
    setActivePluginRegistry(active);

    const providers = resolvePluginCapabilityProviders({ key: "speechProviders" });

    expect(providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it.each([
    ["speechProviders", "speechProviders"],
    ["mediaUnderstandingProviders", "mediaUnderstandingProviders"],
    ["imageGenerationProviders", "imageGenerationProviders"],
  ] as const)("applies bundled compat before fallback loading for %s", (key, contractKey) => {
    const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
    const allowlistCompat = { plugins: { allow: ["custom-plugin", "openai"] } };
    const enablementCompat = {
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
          contracts: { [contractKey]: ["openai"] },
        },
        {
          id: "custom-plugin",
          origin: "workspace",
          contracts: {},
        },
      ] as never,
      diagnostics: [],
    });
    mocks.withBundledPluginAllowlistCompat.mockReturnValue(allowlistCompat);
    mocks.withBundledPluginEnablementCompat.mockReturnValue(enablementCompat);
    mocks.withBundledPluginVitestCompat.mockReturnValue(enablementCompat);

    resolvePluginCapabilityProviders({ key, cfg });

    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["openai"],
    });
    expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
      config: allowlistCompat,
      pluginIds: ["openai"],
    });
    expect(mocks.withBundledPluginVitestCompat).toHaveBeenCalledWith({
      config: enablementCompat,
      pluginIds: ["openai"],
      env: process.env,
    });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith({
      config: enablementCompat,
    });
  });
});
