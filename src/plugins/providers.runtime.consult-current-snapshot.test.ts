import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
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

let request = { config: {}, env: {}, workspaceDir: "/workspace/a" };

function armFallbackLoad(index = makeIndex()) {
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: index,
    diagnostics: [],
  });
}

function registerCurrentSnapshot() {
  const index = makeIndex();
  index.policyHash = resolveInstalledPluginIndexPolicyHash(request.config);
  armFallbackLoad(index);
  const snapshot = loadPluginMetadataSnapshot({ ...request, index });
  setCurrentPluginMetadataSnapshot(snapshot, request);
  loadPluginRegistrySnapshotWithMetadata.mockClear();
  loadPluginManifestRegistryForInstalledIndex.mockClear();
}

describe("provider runtime consults the current plugin metadata snapshot", () => {
  beforeEach(() => {
    request = { config: {}, env: {}, workspaceDir: "/workspace/a" };
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    const registry = makePluginMetadataManifestRegistry("demo");
    for (const plugin of registry.plugins) {
      plugin.commandAliases = [];
    }
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  it("reuses a compatible current snapshot for the in-flight check", () => {
    registerCurrentSnapshot();
    isPluginProvidersLoadInFlight(request);

    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("falls back to a direct disk load when no current snapshot is registered", () => {
    armFallbackLoad();

    isPluginProvidersLoadInFlight(request);

    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
  });

  it("reuses a compatible current snapshot for external auth profiles", () => {
    registerCurrentSnapshot();

    const profiles = resolveExternalAuthProfilesWithPlugins({
      ...request,
      context: { env: {}, store: { version: 1, profiles: {} } },
    });

    expect(profiles).toEqual([]);
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });
});
