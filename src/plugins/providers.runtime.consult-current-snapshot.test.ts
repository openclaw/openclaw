import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

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

import { resolveExternalAuthProfilesWithPlugins } from "./provider-runtime.js";
import { isPluginProvidersLoadInFlight } from "./providers.runtime.js";

const WORKSPACE = "/workspace/a";

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const registry = makePluginMetadataManifestRegistry(pluginId);
  // Provider fixtures intentionally declare no command aliases.
  for (const plugin of registry.plugins) {
    plugin.commandAliases = [];
  }
  return registry;
}

function registerCurrentSnapshot(config: OpenClawConfig, workspaceDir = WORKSPACE) {
  const index = makeIndex();
  index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: index,
    diagnostics: [],
  });
  const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index, workspaceDir });
  setCurrentPluginMetadataSnapshot(snapshot, { config, env: {}, workspaceDir });
  loadPluginRegistrySnapshotWithMetadata.mockClear();
  loadPluginManifestRegistryForInstalledIndex.mockClear();
  return snapshot;
}

function armFallbackLoad() {
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: makeIndex(),
    diagnostics: [],
  });
}

describe("provider runtime consults the current plugin metadata snapshot", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  describe("isPluginProvidersLoadInFlight", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      isPluginProvidersLoadInFlight({ config, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      isPluginProvidersLoadInFlight({ config: {}, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });

  describe("resolveExternalAuthProfilesWithPlugins", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      const profiles = resolveExternalAuthProfilesWithPlugins({
        config,
        env: {},
        workspaceDir: WORKSPACE,
        context: { env: {}, store: { version: 1, profiles: {} } },
      });

      expect(profiles).toEqual([]);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    });
  });
});
