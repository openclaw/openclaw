// Verifies lifecycle snapshot loading, ownership facts, and immutable boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  resolveProviderEndpoint,
  resolveProviderRequestPolicy,
} from "../agents/provider-attribution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry as makeManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { normalizeManifestProviderEndpoints } from "./manifest-capability-normalizers.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const { loadPluginRegistrySnapshotWithMetadata, loadPluginManifestRegistryForInstalledIndex } =
  vi.hoisted(() => {
    // Shared plugin workers must load this graph after this file's mocks are installed.
    vi.resetModules();
    return {
      loadPluginRegistrySnapshotWithMetadata: vi.fn(),
      loadPluginManifestRegistryForInstalledIndex: vi.fn(),
    };
  });

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (params: unknown) =>
      loadPluginRegistrySnapshotWithMetadata(params),
  };
});

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

function mockRegistrySnapshot(index: ReturnType<typeof makeIndex>, source = "provided") {
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source,
    snapshot: index,
    diagnostics: [],
  });
}

function prepareRegistry(config: OpenClawConfig = {}, source = "provided") {
  const index = makeIndex();
  index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  mockRegistrySnapshot(index, source);
  return { config, env: {}, index };
}

describe("plugin metadata snapshot", () => {
  it("keeps strict declared ownership separate from public aliases and last-winner views", () => {
    const snapshot = restorePluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "literal-owner", providers: ["literal"] },
          { id: "alias-owner", providers: ["other"], providerAuthAliases: { literal: "other" } },
          { id: "literal-owner", providers: ["ignored-later-declaration"] },
          { id: "setup-owner", setup: { providers: [{ id: "literal" }, { id: "setup-only" }] } },
        ],
      }),
    );
    expect([...(snapshot.declaredProviderOwners.get("literal") ?? [])]).toEqual(["literal-owner"]);
    expect(snapshot.declaredProviderOwners.has("ignored-later-declaration")).toBe(false);
    expect(snapshot.owners.providers.get("literal")).toEqual(["literal-owner", "alias-owner"]);
    expect(snapshot.byPluginId.get("literal-owner")?.providers).toEqual([
      "ignored-later-declaration",
    ]);
    const projected = projectPluginMetadataSnapshot(snapshot, ["setup-owner"]);
    expect([...(projected.declaredProviderOwners.get("literal") ?? [])]).toEqual(["setup-owner"]);
    expect(projectPluginMetadataSnapshot(snapshot, []).declaredProviderOwners.size).toBe(0);
  });

  beforeEach(() => {
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps direct manifest readers on the Gateway inventory", () => {
    const config = {};
    mockRegistrySnapshot(makeIndex());
    const snapshot = loadPluginMetadataSnapshot({ config, env: {} });
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });

    const registry = loadPluginManifestRegistryCore({
      config: { plugins: { enabled: false } },
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: "/unselected-state" },
    });
    expect(registry).toBe(snapshot.manifestRegistry);
  });

  it("refreshes snapshots for the selected environment's discovery policy", async () => {
    const roots: string[] = [];
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", makeTempDir(roots, "openclaw-metadata-process-"));
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: makeTempDir(roots, "openclaw-metadata-selected-"),
      };
      const config = {};
      writeConfigMachineState("plugins.bundledDiscovery", "compat", { env });
      clearBundledDiscoveryModeMemo();
      const index = makeIndex();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config, env);
      mockRegistrySnapshot(index, "persisted");

      const first = loadPluginMetadataSnapshot({ config, env });
      expect(first.index.plugins.map((plugin) => plugin.enabled)).toEqual([true]);
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(first);

      // Doctor updates machine policy and the persisted inventory without changing env paths.
      writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env });
      clearBundledDiscoveryModeMemo();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config, env);
      index.plugins = index.plugins.map((plugin) => ({ ...plugin, enabled: false }));

      const refreshed = loadPluginMetadataSnapshot({ config, env });
      expect(refreshed.index.plugins.map((plugin) => plugin.enabled)).toEqual([false]);
      expect(refreshed.policyHash).toBe(index.policyHash);
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(refreshed);

      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      clearBundledDiscoveryModeMemo();
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(refreshed);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    } finally {
      envSnapshot.restore();
      await Promise.all(roots.map(removeBundledDiscoveryStateRoot));
    }
  });

  it("completes a narrowed planning view before publishing the Gateway inventory", () => {
    const config = {};
    const index = makeIndex();
    index.plugins = [...index.plugins, ...makeIndex("other").plugins];
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    mockRegistrySnapshot(index);
    const registry = makeManifestRegistry();
    registry.plugins.push(...makeManifestRegistry("other").plugins);
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const planning = loadPluginMetadataSnapshot({ config, env: {}, index, pluginIds: ["demo"] });
    expect(planning.plugins.map((plugin) => plugin.id)).toEqual(["demo"]);
    const complete = completePluginMetadataSnapshot({ snapshot: planning, config, env: {} });

    expect(complete?.pluginIds).toBeUndefined();
    expect(complete?.plugins.map((plugin) => plugin.id)).toEqual(["demo", "other"]);
    setGatewayPluginMetadataSnapshot(complete, { config, env: {} });
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(complete);
  });

  it("cold-loads the requested workspace instead of reusing a different lifecycle graph", () => {
    const config = {};
    const sourceWorkspace = "/workspace/source";
    const targetWorkspace = "/workspace/target";
    const staleIndex = makeIndex("stale");
    staleIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    staleIndex.workspaceDir = sourceWorkspace;
    mockRegistrySnapshot(staleIndex);
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("stale"));
    const stale = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: staleIndex,
      workspaceDir: sourceWorkspace,
    });
    setCurrentPluginMetadataSnapshot(stale, { config, env: {}, workspaceDir: sourceWorkspace });

    // Convergence replaced the persisted inventory; a fresh load now sees a different graph.
    const freshIndex = makeIndex("fresh");
    freshIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    freshIndex.workspaceDir = targetWorkspace;
    mockRegistrySnapshot(freshIndex);
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("fresh"));

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      workspaceDir: targetWorkspace,
    });

    expect(resolved.index.plugins.map((plugin) => plugin.pluginId)).toEqual(["fresh"]);
    expect(resolved.configFingerprint).toBe(
      loadPluginMetadataSnapshot({ config, env: {}, workspaceDir: targetWorkspace })
        .configFingerprint,
    );
  });

  it.each(["derived", "persisted"])("keeps an empty %s index authoritative", (source) => {
    const index = makeIndex();
    index.plugins = [];
    const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source,
      snapshot: index,
      diagnostics: [],
      ...(source === "derived" ? { discovery } : {}),
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      ...(source === "persisted" ? { index } : {}),
    });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: expect.objectContaining({ plugins: [] }),
        includeDisabled: true,
      }),
    );
    expect(snapshot.discovery).toBe(source === "derived" ? discovery : undefined);
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.index.plugins).toEqual([]);
  });

  it.each([
    { scope: "workspace", options: { workspaceDir: "/workspace" } },
    { scope: "plugin", options: { pluginIds: ["demo"] } },
    { scope: "empty plugin", options: { pluginIds: [] } },
    { scope: "caller-owned index", options: { index: makeIndex() } },
    { scope: "current bypass", options: { allowCurrent: false } },
    { scope: "persisted bypass", options: { preferPersisted: false } },
    { scope: "state override", options: { stateDir: "/state" } },
  ])("does not publish a cold $scope snapshot as process metadata", ({ options }) => {
    const { config } = prepareRegistry({}, "derived");

    const first = resolvePluginMetadataSnapshot({ config, env: {}, ...options });
    const second = resolvePluginMetadataSnapshot({ config, env: {}, ...options });

    if (options.allowCurrent === false) {
      expect(second).not.toBe(first);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    } else {
      expect(second).toBe(first);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
    }
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
  });

  it("prepares normalized CLI ownership, provider endpoint, and request facts", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    const [other] = makeManifestRegistry("other").plugins;
    if (!plugin || !other) {
      throw new Error("expected manifest plugin fixture");
    }
    plugin.cliBackends = ["DEMO-CLI", "DEMO-CLI"];
    plugin.setup = { cliBackends: ["Demo-CLI", "Other-CLI"] };
    plugin.contracts = { tools: [], webSearchProviders: ["demo-search"] };
    other.cliBackends = ["demo-cli"];
    plugin.providerEndpoints = normalizeManifestProviderEndpoints([
      {
        endpointClass: " openai-public ",
        hosts: [" API.EXAMPLE.COM ", "api.example.com", " "],
        hostSuffixes: [" .API.EXAMPLE.COM "],
        baseUrls: [
          "HTTPS://ROUTE.EXAMPLE.COM/V1/?debug=1#tail",
          "route.example.com/v1/",
          "ftp://invalid.example.com",
          " ",
        ],
      },
      { endpointClass: " ", hosts: ["ignored.example.com"] },
      { endpointClass: "future-endpoint", hosts: ["ignored.example.com"] },
      {
        endpointClass: "google-vertex",
        hostSuffixes: ["-VERTEX.EXAMPLE.COM"],
        googleVertexRegionHostSuffix: " -VERTEX.EXAMPLE.COM ",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["GLOBAL.VERTEX.EXAMPLE.COM"],
        googleVertexRegion: " GLOBAL ",
      },
    ]);
    other.providerEndpoints = [{ endpointClass: "azure-openai", hosts: ["api.example.com"] }];
    registry.plugins.push(other);
    index.plugins = [...index.plugins, ...makeIndex("other").plugins];
    const sourceEndpoints = structuredClone(
      registry.plugins.map((entry) => entry.providerEndpoints),
    );
    plugin.providerRequest = {
      providers: {
        demo: {
          family: "demo-family",
          compatibilityFamily: "moonshot",
          openAICompletions: { supportsStreamingUsage: true },
        },
      },
    };
    mockRegistrySnapshot(index);
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect([...snapshot.owners.cliBackends]).toEqual([
      ["demo-cli", ["demo", "other"]],
      ["other-cli", ["demo"]],
    ]);
    expect([...snapshot.owners.contracts]).toEqual([["webSearchProviders", ["demo"]]]);
    expect(snapshot.owners.providerEndpoints?.slice(0, 4)).toEqual([
      {
        endpointClass: "openai-public",
        hosts: ["api.example.com", "api.example.com"],
        hostSuffixes: [".api.example.com"],
        baseUrls: ["https://route.example.com/v1", "https://route.example.com/v1"],
      },
      {
        endpointClass: "google-vertex",
        hosts: [],
        hostSuffixes: ["-vertex.example.com"],
        baseUrls: [],
        googleVertexRegionHostSuffix: "-vertex.example.com",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["global.vertex.example.com"],
        hostSuffixes: [],
        baseUrls: [],
        googleVertexRegion: "GLOBAL",
      },
      {
        endpointClass: "azure-openai",
        hosts: ["api.example.com"],
        hostSuffixes: [],
        baseUrls: [],
      },
    ]);
    expect(registry.plugins.map((entry) => entry.providerEndpoints)).toEqual(sourceEndpoints);
    for (const baseUrl of ["https://api.example.com", "https://route.example.com/v1?query=1"]) {
      expect(
        resolveProviderRequestPolicy({
          provider: "openai",
          baseUrl,
          providerMetadataOwners: snapshot.owners,
        }),
      ).toMatchObject({
        endpointClass: "openai-public",
        usesKnownNativeOpenAIEndpoint: true,
        usesExplicitProxyLikeEndpoint: false,
        attributionHeaders: { originator: "openclaw" },
      });
    }
    expect(
      resolveProviderEndpoint("https://us-central1-vertex.example.com", snapshot.owners),
    ).toEqual({
      endpointClass: "google-vertex",
      hostname: "us-central1-vertex.example.com",
      googleVertexRegion: "us-central1",
    });
    expect(resolveProviderEndpoint("https://global.vertex.example.com", snapshot.owners)).toEqual({
      endpointClass: "google-vertex",
      hostname: "global.vertex.example.com",
      googleVertexRegion: "GLOBAL",
    });
    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        baseUrl: "https://ignored.example.com",
        providerMetadataOwners: snapshot.owners,
      }),
    ).toMatchObject({
      endpointClass: "custom",
      usesKnownNativeOpenAIEndpoint: false,
      usesExplicitProxyLikeEndpoint: true,
      attributionHeaders: undefined,
    });
    expect(snapshot.owners.providerRequests?.get("demo")).toEqual({
      family: "demo-family",
      compatibilityFamily: "moonshot",
      openAICompletions: { supportsStreamingUsage: true },
    });
  });

  it.each([false, true])(
    "freezes a cloned index instead of caller-owned records (worker: %s)",
    (worker) => {
      const index = makeIndex();
      mockRegistrySnapshot(index);

      const registry = makeManifestRegistry();
      registry.plugins = registry.plugins.map((plugin) => ({
        ...plugin,
        modelIdNormalization: { providers: { demo: { aliases: { raw: "prepared-model" } } } },
      }));
      loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);
      const loaded = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
      const { normalizePluginId: _normalizePluginId, ...transfer } = loaded;
      const snapshot = worker ? restorePluginMetadataSnapshot(structuredClone(transfer)) : loaded;
      expect(snapshot.normalizePluginId(" DEMO ")).toBe("demo");
      expect(snapshot.owners.providers.get("demo")).toEqual(["demo"]);
      expect(snapshot.owners.modelIdNormalizationPolicies.get("demo")).toEqual({
        aliases: { raw: "prepared-model" },
      });
      const callerRecord = index.plugins[0];
      const snapshotRecord = snapshot.index.plugins[0];
      if (!callerRecord || !snapshotRecord) {
        throw new Error("expected metadata records");
      }

      callerRecord.pluginId = "caller-mutated";
      expect(snapshotRecord.pluginId).toBe("demo");
      expect(() => {
        snapshotRecord.pluginId = "snapshot-mutated";
      }).toThrow();
    },
  );
});
