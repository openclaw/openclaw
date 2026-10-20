import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "../plugins/install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync,
} from "../plugins/installed-plugin-index-records.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
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
import { maybeRepairStaleManagedNpmInstallGenerations } from "./doctor-plugin-generations.js";
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

describe("doctor managed npm generation repair", () => {
  it.each([false, true])(
    "does not restore repaired records (independent writer: %s)",
    async (independentWriter) => {
      const stateDir = tempDirs.make("openclaw-doctor-plugin-scope-");
      const env = {
        ...process.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
      };
      await seedInstalledPluginIndex(
        {
          stale: {
            source: "path",
            installPath: path.join(stateDir, "removed-plugin"),
            sourcePath: path.join(stateDir, "removed-plugin"),
          },
        },
        { stateDir, candidates: [] },
      );

      await withPluginCache(createPluginCache(), async () => {
        expect(await loadInstalledPluginIndexInstallRecords({ stateDir })).toHaveProperty("stale");
        const write = () =>
          withPluginCache(createPluginCache(), () =>
            seedInstalledPluginIndex({}, { stateDir, candidates: [] }),
          );
        await (independentWriter ? runOutsidePluginCache(write) : write());
        const retained = await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir });
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

      expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir })).toEqual({});
    },
  );

  it("retires the stale flat install and prunes it after gateway shutdown", async () => {
    const stateDir = tempDirs.make("openclaw-doctor-plugin-generation-");
    const npmDir = path.join(stateDir, "npm");
    const activePackageDir = writeManaged(stateDir, "2026.7.1", true);
    const stalePackageDir = writeManaged(stateDir, "2026.6.11");
    await seedInstalledPluginIndex(
      {
        [PLUGIN_ID]: {
          source: "npm",
          spec: `${PACKAGE_NAME}@latest`,
          installPath: activePackageDir,
          resolvedName: PACKAGE_NAME,
          resolvedSpec: `${PACKAGE_NAME}@2026.7.1`,
          resolvedVersion: "2026.7.1",
          version: "2026.7.1",
        },
      },
      { stateDir, candidates: [] },
    );

    await expect(
      maybeRepairStaleManagedNpmInstallGenerations(repairParams(stateDir)),
    ).resolves.toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(stalePackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);

    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        activeInstallPaths: [activePackageDir],
        npmDir,
      }),
    ).resolves.toBe(1);
    expect(fs.existsSync(stalePackageDir)).toBe(false);
    expect(fs.existsSync(activePackageDir)).toBe(true);
  });

  it("persists the recency fallback when no authoritative record exists", async () => {
    const stateDir = tempDirs.make("openclaw-doctor-plugin-generation-");
    const activePackageDir = writeManaged(stateDir, "1.0.0", true);
    const stalePackageDir = writeManaged(stateDir, "9.0.0");
    setInstallTimestamp(activePackageDir, new Date("2026-01-02T00:00:00.000Z"));
    setInstallTimestamp(stalePackageDir, new Date("2026-01-01T00:00:00.000Z"));
    await seedInstalledPluginIndex({}, { stateDir, candidates: [] });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await maybeRepairPluginRegistryState({
      config: {
        plugins: {
          allow: [PLUGIN_ID],
          entries: { [PLUGIN_ID]: { enabled: true } },
        },
      },
      ...repairParams(stateDir),
    });

    const persisted = await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir });
    expect(persisted?.[PLUGIN_ID]?.installPath).toBe(activePackageDir);
    expect(hasRetainedManagedNpmInstallMarker(stalePackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
  });
});
