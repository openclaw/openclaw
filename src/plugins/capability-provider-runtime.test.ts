import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

let discoveryCompatRoot: string | undefined;
let discoveryEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
function setBundledDiscoveryCompat(): void {
  if (!discoveryCompatRoot) {
    discoveryCompatRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capability-compat-")),
    );
    const seedSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", discoveryCompatRoot);
    try {
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
    } finally {
      seedSnapshot.restore();
    }
  }
  discoveryEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", discoveryCompatRoot);
  clearBundledDiscoveryModeMemo();
}
function restoreBundledDiscoveryState(): void {
  discoveryEnvSnapshot?.restore();
  discoveryEnvSnapshot = undefined;
  clearBundledDiscoveryModeMemo();
}

function createEmptyMockManifestRegistry(): PluginManifestRegistry {
  return { plugins: [], diagnostics: [] };
}

const mocks = vi.hoisted(() => ({
  createMockRegistry: () => ({
    plugins: [],
    diagnostics: [],
    embeddingProviders: [],
    speechProviders: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
  }),
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  loadPluginManifestRegistryCore: vi.fn<
    (params?: Record<string, unknown>) => PluginManifestRegistry
  >(() => createEmptyMockManifestRegistry()),
  resolveInstalledManifestRegistryIndexFingerprint: vi.fn(() => "test-installed-index"),
  loadBundledCapabilityRuntimeRegistry: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn<(_params?: unknown) => InstalledPluginIndex>(
    () => createPluginMetadataSnapshotFixture().index,
  ),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("./active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: (params?: { requiredPluginIds?: string[] }) => {
    if (params === undefined) {
      return mocks.resolveRuntimePluginRegistry();
    }
    return mocks.resolveRuntimePluginRegistry({
      onlyPluginIds: params.requiredPluginIds,
    });
  },
}));

vi.mock("./bundled-capability-runtime.js", () => ({
  loadBundledCapabilityRuntimeRegistry: mocks.loadBundledCapabilityRuntimeRegistry,
}));

vi.mock("./manifest-registry-installed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry-installed.js")>()),
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryCore,
  resolveInstalledManifestRegistryIndexFingerprint:
    mocks.resolveInstalledManifestRegistryIndexFingerprint,
}));

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: mocks.loadPluginManifestRegistryCore,
  };
});

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
    loadPluginRegistrySnapshotWithMetadata: (params?: { index?: InstalledPluginIndex }) => {
      const snapshot = params?.index ?? mocks.loadPluginRegistrySnapshot(params);
      return {
        snapshot: {
          ...snapshot,
          plugins:
            snapshot.plugins.length > 0
              ? snapshot.plugins
              : createPluginMetadataSnapshotFixture({
                  plugins: [{ id: "__test_manifest_registry_fixture__" }],
                }).index.plugins,
        },
        source: params?.index ? "provided" : "derived",
        diagnostics: [],
      };
    },
    loadPluginManifestRegistryForPluginRegistry: (
      ...args: Parameters<typeof mocks.loadPluginManifestRegistryCore>
    ) => {
      const [{ includeDisabled: _includeDisabled, ...params } = {}] = args as [
        Record<string, unknown>?,
      ];
      return mocks.loadPluginManifestRegistryCore(params);
    },
  };
});

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
}));
let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;
let resolvePluginCapabilityProvider: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider;
let prepareMediaCapabilityProviders: typeof import("./capability-provider-runtime.js").prepareMediaCapabilityProviders;
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;

function expectResolvedCapabilityProviderIds(providers: Array<{ id: string }>, expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: Array<{ id: string }>) {
  expectResolvedCapabilityProviderIds(providers, []);
}

type CapabilityFixtureRegistry = ReturnType<typeof createEmptyPluginRegistry>;
type CapabilityFixtureKey = Parameters<typeof resolvePluginCapabilityProviders>[0]["key"];

function addCapabilityProvider(
  registry: CapabilityFixtureRegistry,
  key: CapabilityFixtureKey,
  params: {
    id: string;
    pluginId?: string;
    pluginName?: string;
    provider?: Record<string, unknown>;
  },
) {
  const pluginId = params.pluginId ?? params.id;
  (registry[key] as unknown[]).push({
    pluginId,
    pluginName: params.pluginName ?? pluginId,
    source: "test",
    provider: { id: params.id, ...params.provider },
  });
}

function addSpeechProvider(
  registry: CapabilityFixtureRegistry,
  id: string,
  params: {
    pluginId?: string;
    label?: string;
    aliases?: string[];
  } = {},
) {
  addCapabilityProvider(registry, "speechProviders", {
    id,
    pluginId: params.pluginId,
    provider: {
      label: params.label ?? id,
      ...(params.aliases ? { aliases: params.aliases } : {}),
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.from("x"),
        outputFormat: "mp3",
        voiceCompatible: false,
        fileExtension: ".mp3",
      }),
    },
  });
}

function setCapabilityManifestPlugins(
  plugins: Array<{
    id: string;
    origin?: "bundled" | "global";
    enabledByDefault?: boolean;
    contracts: Record<string, string[]>;
  }>,
) {
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: plugins.map(createPluginManifestRecordFixture),
    diagnostics: [],
  });
}

function expectActiveRegistryLookup(pluginIds: string[]) {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({ onlyPluginIds: pluginIds });
}

function expectInitialRuntimeRegistryLookup() {
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenNthCalledWith(1);
}

describe("resolvePluginCapabilityProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      prepareMediaCapabilityProviders,
      resolvePluginCapabilityProvider,
      resolvePluginCapabilityProviders,
    } = await import("./capability-provider-runtime.js"));
    ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
  });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue(createPluginMetadataSnapshotFixture().index);
    mocks.loadPluginManifestRegistryCore.mockReset();
    mocks.loadPluginManifestRegistryCore.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.loadBundledCapabilityRuntimeRegistry.mockReset();
    mocks.loadBundledCapabilityRuntimeRegistry.mockImplementation(() => mocks.createMockRegistry());
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    restoreBundledDiscoveryState();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    restoreBundledDiscoveryState();
  });

  afterAll(async () => {
    restoreBundledDiscoveryState();
    if (discoveryCompatRoot) {
      const stateRoot = discoveryCompatRoot;
      discoveryCompatRoot = undefined;
      await removeBundledDiscoveryStateRoot(stateRoot);
    }
  });

  it("shares installed policy across external owners and refreshes it on the next selection", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `external-${index}`);
    const registry = createEmptyPluginRegistry();
    for (const id of ids) {
      registry.plugins.push(createPluginRecord({ id, origin: "global" }));
      addCapabilityProvider(registry, "imageGenerationProviders", { id });
    }
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: ids.map((id) => ({
        id,
        origin: "global",
        contracts: { imageGenerationProviders: [id] },
      })),
    });
    const firstEntry = { enabled: false };
    let enumerations = 0;
    const entries = new Proxy(
      Object.fromEntries(
        ids.map((id, index) => [id, index === 0 ? firstEntry : { enabled: true }]),
      ),
      {
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const cfg: OpenClawConfig = { plugins: { entries } };
    for (const enabled of [false, true]) {
      firstEntry.enabled = enabled;
      enumerations = 0;
      const prepared = prepareMediaCapabilityProviders({ cfg, pluginMetadataSnapshot, registry });

      expect(prepared.imageGenerationProviders?.map((provider) => provider.id)).toEqual(
        enabled ? ids : ids.slice(1),
      );
      // Manifest, installed, and loaded-provider filters each prepare policy at most once.
      expect(enumerations).toBeLessThanOrEqual(3);
    }
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { blocked: { enabled: false } } },
    },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed"] } },
  ])("never prepares or executes a $name bundled capability provider", ({ plugins }) => {
    const generateImage = vi.fn();
    const registry = createEmptyPluginRegistry();
    addCapabilityProvider(registry, "imageGenerationProviders", {
      id: "blocked",
      provider: { generateImage },
    });
    const prepared = prepareMediaCapabilityProviders({
      cfg: { plugins } as OpenClawConfig,
      registry,
      pluginMetadataSnapshot: {
        index: { plugins: [{ pluginId: "blocked", origin: "bundled", enabled: false }] },
        plugins: [
          {
            id: "blocked",
            origin: "bundled",
            contracts: { imageGenerationProviders: ["blocked"] },
          },
        ],
      } as never,
    });

    for (const provider of prepared.imageGenerationProviders ?? []) {
      (provider as unknown as { generateImage: () => void }).generateImage();
    }

    expect(generateImage).not.toHaveBeenCalled();
    expect(prepared.imageGenerationProviders).toEqual([]);
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { blocked: { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed"] } },
  ])("never imports a $name bundled provider through cold compatibility capture", ({ plugins }) => {
    const captured = createEmptyPluginRegistry();
    addCapabilityProvider(captured, "imageGenerationProviders", { id: "blocked" });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);
    setCapabilityManifestPlugins([
      { id: "blocked", contracts: { imageGenerationProviders: ["blocked"] } },
    ]);

    expect(
      resolvePluginCapabilityProviders({
        key: "imageGenerationProviders",
        cfg: { plugins },
      }),
    ).toEqual([]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("preserves restrictive-allowlist compatibility only for known bundled active owners", () => {
    setBundledDiscoveryCompat();
    const active = createEmptyPluginRegistry();
    active.plugins.push({ id: "bundled-owner", origin: "bundled" } as never);
    addSpeechProvider(active, "bundled-provider", { pluginId: "bundled-owner" });
    addSpeechProvider(active, "unknown-provider", { pluginId: "unknown-owner" });
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );
    const cfg = { plugins: { allow: ["allowed-plugin"] } } as OpenClawConfig;

    expect(
      resolvePluginCapabilityProvider({
        key: "speechProviders",
        providerId: "bundled-provider",
        cfg,
      })?.id,
    ).toBe("bundled-provider");
    expect(
      resolvePluginCapabilityProvider({
        key: "speechProviders",
        providerId: "unknown-provider",
        cfg,
      }),
    ).toBeUndefined();
    expect(resolvePluginCapabilityProviders({ key: "speechProviders", cfg })).toEqual([
      expect.objectContaining({ id: "bundled-provider" }),
    ]);
  });

  it("leaves a media family unresolved for loaded providers without contracts", () => {
    const loaded = createEmptyPluginRegistry();
    addCapabilityProvider(loaded, "imageGenerationProviders", { id: "legacy-image" });

    const prepared = prepareMediaCapabilityProviders({
      registry: loaded,
      pluginMetadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    });

    expect(prepared.imageGenerationProviders).toBeUndefined();
  });

  it.each(["active", "manifest"] as const)(
    "applies current normalized policy to every %s provider lookup",
    (source) => {
      const registry = createEmptyPluginRegistry();
      addSpeechProvider(registry, "first");
      addSpeechProvider(registry, "second");
      setCapabilityManifestPlugins([
        { id: "first", contracts: { speechProviders: ["first"] } },
        { id: "second", contracts: { speechProviders: ["second"] } },
      ]);
      mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
        source === "active" || options !== undefined ? registry : undefined,
      );
      const plugins = {
        allow: [" FIRST ", "second"],
        deny: [] as string[],
        entries: { " FIRST ": { enabled: true }, second: { enabled: false } },
      };
      const cfg: OpenClawConfig = { plugins };
      const resolve = () => resolvePluginCapabilityProviders({ key: "speechProviders", cfg });

      expect(resolve()).toEqual([registry.speechProviders[0]?.provider]);
      plugins.entries[" FIRST "].enabled = false;
      plugins.entries.second.enabled = true;
      expect(resolve()).toEqual([registry.speechProviders[1]?.provider]);
      plugins.deny.push(" SECOND ");
      expect(resolve()).toEqual([]);
    },
  );

  it("merges enabled generation providers missing from the active registry", () => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, "imageGenerationProviders", {
      id: "xai",
    });
    const loaded = createEmptyPluginRegistry();
    addCapabilityProvider(loaded, "imageGenerationProviders", {
      id: "fal",
    });
    addCapabilityProvider(loaded, "imageGenerationProviders", {
      id: "xai",
      provider: { defaultModel: "shadowed-model" },
    });
    addCapabilityProvider(loaded, "imageGenerationProviders", {
      id: "unconfigured-image",
      provider: { isConfigured: () => false },
    });
    setCapabilityManifestPlugins(
      ["fal", "xai", "unconfigured-image"].map((id) => ({
        id,
        contracts: { imageGenerationProviders: [id] },
      })),
    );
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const cfg: OpenClawConfig = { plugins: { allow: ["fal", "xai", "unconfigured-image"] } };
    const providers = resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg,
    });

    expectResolvedCapabilityProviderIds(providers, ["xai", "fal", "unconfigured-image"]);
    expect(providers[0]).toBe(active.imageGenerationProviders[0]?.provider);
    expect(providers[1]).toBe(loaded.imageGenerationProviders[0]?.provider);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expectActiveRegistryLookup(["fal", "unconfigured-image", "xai"]);

    const requestedProviders = resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg,
      additionalProviderIds: [" FAL ", "fal"],
    });
    expectResolvedCapabilityProviderIds(requestedProviders, ["xai", "fal", "unconfigured-image"]);
    expect(requestedProviders[0]).toBe(active.imageGenerationProviders[0]?.provider);
    expect(requestedProviders[1]).toBe(loaded.imageGenerationProviders[0]?.provider);
  });

  it.each([
    ["voice model", "speechProviders", { agents: { defaults: { voiceModel: "openai/model" } } }],
    ["sole Talk speech", "speechProviders", { talk: { providers: { openai: {} } } }],
    [
      "Talk speech alias",
      "speechProviders",
      { talk: { provider: "voice-alias", providers: { "voice-alias": {} } } },
    ],
    [
      "Talk realtime alias",
      "realtimeVoiceProviders",
      { talk: { realtime: { provider: "voice-alias", providers: { "voice-alias": {} } } } },
    ],
  ] as const)("loads a missing provider requested by %s", (_source, key, cfg) => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, key, { id: "google" });
    const loaded = createEmptyPluginRegistry();
    addCapabilityProvider(loaded, key, { id: "openai", provider: { aliases: ["voice-alias"] } });
    setCapabilityManifestPlugins([
      { id: "google", contracts: { [key]: ["google"] } },
      { id: "openai", contracts: { [key]: ["openai", "voice-alias"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key, cfg: cfg as OpenClawConfig });

    expectResolvedCapabilityProviderIds(providers, ["google", "openai"]);
    expectActiveRegistryLookup(["openai"]);
  });

  it.each([
    { name: "complete", complete: true, disabled: false },
    { name: "partial", complete: false, disabled: false },
    { name: "disabled", complete: true, disabled: true },
  ])(
    "keeps $name prepared media facts distinct from unresolved discovery",
    ({ complete, disabled }) => {
      const registry = createEmptyPluginRegistry();
      const ids = complete ? ["qa-image", "qa-audio"] : ["qa-image"];
      for (const id of ids) {
        addCapabilityProvider(registry, "mediaUnderstandingProviders", { id });
        registry.plugins.push(createPluginRecord({ id, origin: "bundled" }));
      }
      const prepared = prepareMediaCapabilityProviders({
        cfg: { plugins: { enabled: !disabled, allow: ["qa-image", "qa-audio"] } },
        registry,
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: ["qa-image", "qa-audio"].map((id) => ({
            id,
            contracts: { mediaUnderstandingProviders: [id] },
          })),
        }),
      });
      if (disabled) {
        expect(prepared.mediaUnderstandingProviders).toEqual([]);
      } else if (!complete) {
        expect(prepared.mediaUnderstandingProviders).toBeUndefined();
      } else {
        expect(prepared.mediaUnderstandingProviders?.map(({ id }) => id).toSorted()).toEqual([
          "qa-audio",
          "qa-image",
        ]);
      }
    },
  );

  it("keeps the full media provider family available with explicit models", () => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, "mediaUnderstandingProviders", {
      id: "openai",
      pluginName: "OpenAI",
      provider: { capabilities: ["image"] },
    });
    const loaded = createEmptyPluginRegistry();
    addCapabilityProvider(loaded, "mediaUnderstandingProviders", {
      id: "deepgram",
      pluginName: "Deepgram",
      provider: { capabilities: ["audio"] },
    });
    addCapabilityProvider(loaded, "mediaUnderstandingProviders", {
      id: "google",
      pluginName: "Google",
      provider: { capabilities: ["image", "audio", "video"] },
    });
    setCapabilityManifestPlugins([
      {
        id: "deepgram",
        origin: "bundled",
        contracts: { mediaUnderstandingProviders: ["deepgram"] },
      },
      {
        id: "google",
        origin: "bundled",
        contracts: { mediaUnderstandingProviders: ["google"] },
      },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );

    const providers = resolvePluginCapabilityProviders({
      key: "mediaUnderstandingProviders",
      cfg: {
        plugins: { allow: ["openai", "deepgram", "google"] },
        tools: {
          media: {
            models: [{ provider: "deepgram", model: "nova-3", capabilities: ["audio"] }],
            audio: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "deepgram", "google"]);
    expect(providers[0]).toBe(active.mediaUnderstandingProviders[0]?.provider);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup(["deepgram", "google"]);
  });

  it("keeps active speech providers when cfg requests an active provider alias", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "microsoft", { aliases: ["edge"] });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        plugins: { entries: { microsoft: { enabled: true } } },
        tts: { provider: "edge" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expectInitialRuntimeRegistryLookup();
  });

  it("uses bundled capability capture when runtime snapshot misses a requested speech provider", () => {
    const active = createEmptyPluginRegistry();
    addSpeechProvider(active, "openai");
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "azure-speech", { label: "Azure Speech" });
    const captured = createEmptyPluginRegistry();
    addSpeechProvider(captured, "google");
    setCapabilityManifestPlugins([
      { id: "azure-speech", contracts: { speechProviders: ["azure-speech"] } },
      { id: "google", contracts: { speechProviders: ["google"] } },
    ]);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : loaded,
    );
    mocks.loadBundledCapabilityRuntimeRegistry.mockReturnValue(captured);

    const providers = resolvePluginCapabilityProviders({
      key: "speechProviders",
      cfg: {
        tts: { provider: "google" },
      } as OpenClawConfig,
    });

    expectResolvedCapabilityProviderIds(providers, ["openai", "google"]);
    expect(mocks.loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: ["google"],
      onlyPluginIds: ["google"],
      activate: false,
      config: { tts: { provider: "google" } },
    });
  });

  it("prefers a canonical provider id over an earlier provider alias", () => {
    const active = createEmptyPluginRegistry();
    addCapabilityProvider(active, "speechProviders", {
      id: "microsoft",
      pluginName: "Microsoft",
      provider: { aliases: [" EDGE "], label: "Microsoft" },
    });
    addCapabilityProvider(active, "speechProviders", {
      id: "edge",
      pluginName: "Edge",
      provider: { label: "Edge" },
    });
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const provider = resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId: "edge",
    });

    expect(provider?.id).toBe("edge");
  });

  it.each([
    ["partial alias", ["google", "edge"], [], ["google", "microsoft"]],
    ["unknown alias", ["edge", "unknown"], [], ["google", "microsoft", "elevenlabs"]],
    ["denied canonical", ["google", "edge"], ["google"], ["microsoft", "elevenlabs"]],
  ] as const)("preserves cold %s provider coverage", (_name, requested, deny, expected) => {
    const loaded = createEmptyPluginRegistry();
    addSpeechProvider(loaded, "google");
    addSpeechProvider(loaded, "microsoft", { aliases: ["edge"] });
    addSpeechProvider(loaded, "elevenlabs");
    setCapabilityManifestPlugins(
      ["google", "microsoft", "elevenlabs"].map((id) => ({
        id,
        contracts: { speechProviders: [id] },
      })),
    );
    mocks.resolveRuntimePluginRegistry.mockImplementation((options?: unknown) =>
      options === undefined ? undefined : loaded,
    );
    const cfg: OpenClawConfig = {
      plugins: { allow: ["google", "microsoft", "elevenlabs"], deny: [...deny] },
      tts: {
        provider: requested[0],
        providers: Object.fromEntries(requested.slice(1).map((id) => [id, {}])),
      },
    };

    expectResolvedCapabilityProviderIds(
      resolvePluginCapabilityProviders({ key: "speechProviders", cfg }),
      [...expected],
    );
  });

  it("uses an explicit empty plugin scope when no bundled owner exists", () => {
    const key = "musicGenerationProviders";
    const providers = resolvePluginCapabilityProviders({
      key,
      cfg: {} as OpenClawConfig,
    });

    expectNoResolvedCapabilityProviders(providers as Array<{ id: string }>);
    expectInitialRuntimeRegistryLookup();
    expectActiveRegistryLookup([]);
  });

  it("does not load targeted non-speech capability providers when plugins are globally disabled", () => {
    const cfg = { plugins: { enabled: false, allow: ["custom-plugin"] } } as OpenClawConfig;
    const provider = resolvePluginCapabilityProvider({
      key: "embeddingProviders",
      providerId: "gemini",
      cfg,
    });

    expect(provider).toBeUndefined();
    expect(mocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expect(mocks.withBundledPluginEnablementCompat).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });
});
