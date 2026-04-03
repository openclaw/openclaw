import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "./registry.js";

type MockManifestRegistry = {
  plugins: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  loadPluginManifestRegistry: vi.fn<() => MockManifestRegistry>(() =>
    createEmptyMockManifestRegistry(),
  ),
  withBundledPluginAllowlistCompat: vi.fn(({ config }) => config),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
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

function expectResolvedCapabilityProviderIds(providers: Array<{ id: string }>, expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: Array<{ id: string }>) {
  expectResolvedCapabilityProviderIds(providers, []);
}

function expectBundledCompatLoadPath(params: {
  cfg: OpenClawConfig;
  allowlistCompat: { plugins: { allow: string[] } };
  enablementCompat: {
    plugins: {
      allow: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
    config: params.cfg,
    env: process.env,
  });
  expect(mocks.withBundledPluginAllowlistCompat).toHaveBeenCalledWith({
    config: params.cfg,
    pluginIds: ["openai"],
  });
  expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
    config: params.allowlistCompat,
    pluginIds: ["openai"],
  });
  expect(mocks.withBundledPluginVitestCompat).toHaveBeenCalledWith({
    config: params.enablementCompat,
    pluginIds: ["openai"],
    env: process.env,
  });
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
    config: params.enablementCompat,
    activate: false,
    cache: false,
  });
}

function createCompatChainConfig() {
  const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
  const allowlistCompat = { plugins: { allow: ["custom-plugin", "openai"] } };
  const enablementCompat = {
    plugins: {
      allow: ["custom-plugin", "openai"],
      entries: { openai: { enabled: true } },
    },
  };
  return { cfg, allowlistCompat, enablementCompat };
}

function setBundledCapabilityFixture(contractKey: string) {
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
}

function expectCompatChainApplied(params: {
  key: "speechProviders" | "mediaUnderstandingProviders" | "imageGenerationProviders";
  contractKey: string;
  cfg: OpenClawConfig;
  allowlistCompat: { plugins: { allow: string[] } };
  enablementCompat: {
    plugins: {
      allow: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  setBundledCapabilityFixture(params.contractKey);
  mocks.withBundledPluginAllowlistCompat.mockReturnValue(params.allowlistCompat);
  mocks.withBundledPluginEnablementCompat.mockReturnValue(params.enablementCompat);
  mocks.withBundledPluginVitestCompat.mockReturnValue(params.enablementCompat);
  expectNoResolvedCapabilityProviders(
    resolvePluginCapabilityProviders({ key: params.key, cfg: params.cfg }),
  );
  expectBundledCompatLoadPath(params);
}

describe("resolvePluginCapabilityProviders", () => {
  beforeAll(async () => {
    ({ resolvePluginCapabilityProviders } = await import("./capability-provider-runtime.js"));
  });

  beforeEach(() => {
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.withBundledPluginAllowlistCompat.mockReset();
    mocks.withBundledPluginAllowlistCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginVitestCompat.mockReset();
    mocks.withBundledPluginVitestCompat.mockImplementation(({ config }) => config);
  });

  it("uses the active registry when capability providers are already loaded", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({ key: "speechProviders" });

    expectResolvedCapabilityProviderIds(providers, ["openai"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
  });

  it("keeps active capability providers even when cfg is passed", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      source: "test",
      provider: {
        id: "microsoft",
        label: "microsoft",
        aliases: ["edge"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: { messages: { tts: { provider: "edge" } } } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    // No bundled speech plugins declared in the manifest, so the capability
    // loader is skipped — all active providers are already covered.
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["speechProviders", "speechProviders"],
    ["mediaUnderstandingProviders", "mediaUnderstandingProviders"],
    ["imageGenerationProviders", "imageGenerationProviders"],
  ] as const)("applies bundled compat before fallback loading for %s", (key, contractKey) => {
    const { cfg, allowlistCompat, enablementCompat } = createCompatChainConfig();
    expectCompatChainApplied({
      key,
      contractKey,
      cfg,
      allowlistCompat,
      enablementCompat,
    });
  });

  it("runs capability loader when bundled speech-only plugin is missing from active registry", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "openai",
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        }),
      },
    } as never);

    const capabilityRegistry = createEmptyPluginRegistry();
    capabilityRegistry.speechProviders.push(
      {
        pluginId: "openai",
        pluginName: "openai",
        source: "test",
        provider: {
          id: "openai",
          label: "openai",
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: Buffer.from("x"),
            outputFormat: "mp3",
            voiceCompatible: false,
            fileExtension: ".mp3",
          }),
        },
      } as never,
      {
        pluginId: "elevenlabs",
        pluginName: "elevenlabs",
        source: "test",
        provider: {
          id: "elevenlabs",
          label: "elevenlabs",
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: Buffer.from("x"),
            outputFormat: "mp3",
            voiceCompatible: false,
            fileExtension: ".mp3",
          }),
        },
      } as never,
    );

    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : capabilityRegistry,
    );

    // Manifest declares both openai and elevenlabs as bundled speech plugins
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "openai", origin: "bundled", contracts: { speechProviders: ["openai"] } },
        { id: "elevenlabs", origin: "bundled", contracts: { speechProviders: ["elevenlabs"] } },
      ] as never,
      diagnostics: [],
    });

    const cfg = {} as OpenClawConfig;
    const providers = resolvePluginCapabilityProviders({ key: "speechProviders", cfg });

    // Both providers should be present: openai from active + elevenlabs from loader
    expectResolvedCapabilityProviderIds(providers, ["openai", "elevenlabs"]);
    // Loader should have been called because elevenlabs was missing from active
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ activate: false, cache: false }),
    );
  });

  it("skips capability loader when all bundled plugins are already in active registry", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push(
      {
        pluginId: "openai",
        pluginName: "openai",
        source: "test",
        provider: {
          id: "openai",
          label: "openai",
          isConfigured: () => true,
          synthesize: async () => ({}),
        },
      } as never,
      {
        pluginId: "elevenlabs",
        pluginName: "elevenlabs",
        source: "test",
        provider: {
          id: "elevenlabs",
          label: "elevenlabs",
          isConfigured: () => true,
          synthesize: async () => ({}),
        },
      } as never,
    );
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "openai", origin: "bundled", contracts: { speechProviders: ["openai"] } },
        { id: "elevenlabs", origin: "bundled", contracts: { speechProviders: ["elevenlabs"] } },
      ] as never,
      diagnostics: [],
    });

    const cfg = {} as OpenClawConfig;
    const providers = resolvePluginCapabilityProviders({ key: "speechProviders", cfg });

    expectResolvedCapabilityProviderIds(providers, ["openai", "elevenlabs"]);
    // No loader call — only the initial resolveRuntimePluginRegistry() for active registry
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("reuses a compatible active registry even when the capability list is empty", () => {
    const active = createEmptyPluginRegistry();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {} as OpenClawConfig,
    });

    expectNoResolvedCapabilityProviders(providers);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: expect.anything(),
      activate: false,
      cache: false,
    });
  });
});
