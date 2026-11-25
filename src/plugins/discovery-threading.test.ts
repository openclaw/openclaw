import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import * as installedPluginIndexRecordReader from "./installed-plugin-index-record-reader.js";
import { createInstalledPluginIndexCandidate as createCandidate } from "./test-helpers/installed-plugin-index.js";

const discoverOpenClawPluginsMock = vi.fn();

vi.mock("./discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery.js")>();
  return {
    ...actual,
    discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
  };
});

const { loadPluginManifestRegistryCore } = await import("./manifest-registry.js");
const { loadInstalledPluginIndexWithDiscovery } = await import("./installed-plugin-index.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const candidate = (id: string) =>
  createCandidate(tempDirs.make("openclaw-discovery-input-"), { id });

afterEach(() => vi.restoreAllMocks());

describe("plugin discovery inputs", () => {
  beforeEach(() => discoverOpenClawPluginsMock.mockReset());

  it.each(["manifest registry", "installed index"])(
    "selects inputs for the %s without rescanning supplied inventory",
    (consumer) => {
      const loadIds = (params: Parameters<typeof loadPluginManifestRegistryCore>[0] = {}) => {
        const input = { ...params, installRecords: {} };
        return consumer === "manifest registry"
          ? loadPluginManifestRegistryCore(input).plugins.map((plugin) => plugin.id)
          : loadInstalledPluginIndexWithDiscovery(input).index.plugins.map(
              (plugin) => plugin.pluginId,
            );
      };
      const discovery: PluginDiscoveryResult = {
        candidates: [candidate("captured")],
        diagnostics: [],
      };
      discoverOpenClawPluginsMock.mockReturnValue({
        candidates: [candidate("scanned")],
        diagnostics: [],
      });

      expect(loadIds()).toEqual(["scanned"]);
      expect(discoverOpenClawPluginsMock).toHaveBeenCalledOnce();
      discoverOpenClawPluginsMock.mockClear();

      expect(loadIds({ discovery })).toEqual(["captured"]);
      expect(loadIds({ candidates: [candidate("explicit")], discovery })).toEqual(["explicit"]);
      expect(loadIds({ candidates: [], discovery })).toEqual([]);
      expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
    },
  );

  it("preserves explicit candidate diagnostics without loading persisted install records", () => {
    const readInstallRecords = vi.spyOn(
      installedPluginIndexRecordReader,
      "loadInstalledPluginIndexInstallRecordsSync",
    );
    const diagnostics = [{ level: "warn" as const, message: "explicit candidate diagnostic" }];

    const result = loadInstalledPluginIndexWithDiscovery({
      candidates: [],
      diagnostics,
      installRecords: {},
    });

    expect(result.manifestRegistry.diagnostics).toEqual(diagnostics);
    expect(result.discovery).toBeUndefined();
    expect(readInstallRecords).not.toHaveBeenCalled();
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
