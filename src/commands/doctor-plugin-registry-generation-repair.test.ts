import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "../plugins/install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords,
} from "../plugins/installed-plugin-index-records.js";
import {
  cleanupRetainedManagedNpmInstallGenerations as pruneGenerations,
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "../plugins/managed-npm-retention.js";
import {
  createPluginCache,
  runOutsidePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeRepairStaleManagedNpmInstallGenerations as repairGenerations } from "./doctor-plugin-generations.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";

const PACKAGE_NAME = "@proof/openclaw-generation";
const PLUGIN_ID = "generation-proof";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeManaged(stateDir: string, version: string, generation = false): string {
  const npmDir = path.join(stateDir, "npm");
  writeManagedNpmPlugin({ stateDir, packageName: PACKAGE_NAME, pluginId: PLUGIN_ID, version });
  let project = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  if (generation) {
    const target = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: PACKAGE_NAME,
      generationKey: `${PACKAGE_NAME}@${version}`,
    });
    fs.renameSync(project, target);
    project = target;
  }
  return path.join(project, "node_modules", ...PACKAGE_NAME.split("/"));
}

const repairParams = (stateDir: string) => ({
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  prompter: { shouldRepair: true },
  stateDir,
});

function setInstallTimestamp(packageDir: string, timestamp: Date): void {
  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!packageInfo) {
    throw new Error(`Expected managed npm package dir: ${packageDir}`);
  }
  for (const directory of [packageDir, packageInfo.projectRoot]) {
    fs.utimesSync(path.join(directory, "package.json"), timestamp, timestamp);
    fs.utimesSync(directory, timestamp, timestamp);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
});

it.each([false, true])(
  "does not restore repaired records (independent writer: %s)",
  async (independentWriter) => {
    const stateDir = tempDirs.make("openclaw-doctor-plugin-scope-");
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const removed = path.join(stateDir, "removed-plugin");
    await seedInstalledPluginIndex(
      { stale: { source: "path", installPath: removed, sourcePath: removed } },
      { stateDir, candidates: [] },
    );

    await withPluginCache(createPluginCache(), async () => {
      expect(await loadInstalledPluginIndexInstallRecords({ stateDir })).toHaveProperty("stale");
      const write = () =>
        withPluginCache(createPluginCache(), () =>
          seedInstalledPluginIndex({}, { stateDir, candidates: [] }),
        );
      await (independentWriter ? runOutsidePluginCache(write) : write());
      const retained = await readRecords({ stateDir });
      if (independentWriter) {
        expect(retained).toHaveProperty("stale");
      } else {
        expect(retained).toEqual({});
      }

      await maybeRepairPluginRegistryState({
        config: {},
        env,
        prompter: { shouldRepair: true },
        stateDir,
      });
    });

    expect(await readRecords({ stateDir })).toEqual({});
  },
);

it.each(["record", "recency"] as const)(
  "retires stale generations using %s authority",
  async (authority) => {
    const stateDir = tempDirs.make("openclaw-doctor-plugin-generation-");
    const active = writeManaged(stateDir, authority === "record" ? "2026.7.1" : "1.0.0", true);
    const stale = writeManaged(stateDir, authority === "record" ? "2026.6.11" : "9.0.0");
    await seedInstalledPluginIndex(
      authority === "record"
        ? {
            [PLUGIN_ID]: {
              source: "npm",
              spec: `${PACKAGE_NAME}@latest`,
              installPath: active,
              resolvedVersion: "2026.7.1",
            },
          }
        : {},
      { stateDir, candidates: [] },
    );
    if (authority === "recency") {
      setInstallTimestamp(active, new Date("2026-01-02T00:00:00.000Z"));
      setInstallTimestamp(stale, new Date("2026-01-01T00:00:00.000Z"));
      vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      await maybeRepairPluginRegistryState({
        ...repairParams(stateDir),
        config: { plugins: { allow: [PLUGIN_ID], entries: { [PLUGIN_ID]: { enabled: true } } } },
      });
      const persisted = await readRecords({ stateDir });
      expect(persisted?.[PLUGIN_ID]?.installPath).toBe(active);
    } else {
      await expect(repairGenerations(repairParams(stateDir))).resolves.toBe(true);
    }
    expect([stale, active].map(hasRetainedManagedNpmInstallMarker)).toEqual([true, false]);
    if (authority === "record") {
      await expect(
        pruneGenerations({
          activeInstallPaths: [active],
          npmDir: path.join(stateDir, "npm"),
        }),
      ).resolves.toBe(1);
      expect([stale, active].map((dir) => fs.existsSync(dir))).toEqual([false, true]);
    }
  },
);
