import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { pluginPathFailureDiagnostic } from "./discovery-availability.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "./installed-plugin-index-record-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it("retains discovery's preserve disposition when the installed index is reopened from SQLite", async () => {
  const stateDir = tempDirs.make("openclaw-index-availability-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const discovery = discoverConfiguredPluginLoadPaths({
    loadPaths: [path.join(stateDir, "missing-plugin")],
    env,
  });
  expect(discovery.diagnostics).toEqual([
    expect.objectContaining({
      code: "configured-plugin-path-unavailable",
      configDisposition: "preserve",
    }),
  ]);
  const index: InstalledPluginIndex = {
    version: INSTALLED_PLUGIN_INDEX_VERSION,
    hostContractVersion: "2026.9.4",
    compatRegistryVersion: "availability-fixture",
    migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
    policyHash: "availability-fixture",
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [
      ...discovery.diagnostics,
      pluginPathFailureDiagnostic(
        path.join(stateDir, "unreadable-plugin"),
        "config",
        Object.assign(new Error("Filesystem device error"), { code: "EIO" }),
      ),
      { level: "warn", message: "Existing diagnostics retain an absent disposition." },
      {
        level: "info",
        code: "explicit-config-plugin-selection",
        pluginId: "selected",
        message: "explicit override",
      },
    ],
  };
  await writePersistedInstalledPluginIndex(index, { env, stateDir });
  const stored = getPersistedInstalledPluginIndexCacheEntry({ env, stateDir });
  expect(stored.state).toMatchObject({
    status: "present",
    value: {
      index: {
        version: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ level: "warn", code: "explicit-config-plugin-selection" }),
        ]),
      },
    },
  });
  clearPluginMetadataLifecycleCaches();
  await closeOpenClawStateDatabaseAsync();

  const reopened = readPersistedInstalledPluginIndexSync({ env, stateDir });
  expect(reopened?.diagnostics).toEqual(index.diagnostics);
});
