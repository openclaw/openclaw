import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "./managed-npm-retention.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const PACKAGE_NAME = "@openclaw/discord";
const PLUGIN_ID = "discord";
const managedPlugin = { packageName: PACKAGE_NAME, pluginId: PLUGIN_ID };
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearLoadInstalledPluginIndexInstallRecordsCache();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function packagePath(projectRoot: string) {
  return path.join(projectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

function writeManaged(stateDir: string, version: string, generationKey?: string): string {
  const npmDir = path.join(stateDir, "npm");
  const packageDir = writeManagedNpmPlugin({ stateDir, version, ...managedPlugin });
  if (!generationKey) {
    return packageDir;
  }
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  const generationProjectRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName: PACKAGE_NAME,
    generationKey,
  });
  fs.renameSync(flatProjectRoot, generationProjectRoot);
  return packagePath(generationProjectRoot);
}

function seedAuthority(stateDir: string, installPath: string, dangling = false) {
  return seedInstalledPluginIndex(
    {
      discord: {
        source: "npm",
        installPath,
        resolvedName: PACKAGE_NAME,
        spec: `${PACKAGE_NAME}@${dangling ? "latest" : "1.0.0"}`,
        resolvedVersion: dangling ? "2.0.0" : "1.0.0",
        ...(!dangling ? { version: "1.0.0", resolvedSpec: `${PACKAGE_NAME}@1.0.0` } : {}),
      },
    },
    { stateDir, candidates: [] },
  );
}

function orderInstalls(older: string, newer: string) {
  setInstallTimestamp(older, Date.UTC(2026, 0, 1));
  setInstallTimestamp(newer, Date.UTC(2026, 0, 2));
}

async function expectRecovered(stateDir: string, installPath: string, resolvedVersion = "1.0.0") {
  const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
  expect(loaded.discord).toMatchObject({ installPath, resolvedVersion });
}

function setInstallTimestamp(packageDir: string, timestampMs: number): void {
  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!packageInfo) {
    throw new Error(`Expected managed npm package dir: ${packageDir}`);
  }
  const timestamp = new Date(timestampMs);
  for (const dir of [packageDir, packageInfo.projectRoot]) {
    fs.utimesSync(path.join(dir, "package.json"), timestamp, timestamp);
    fs.utimesSync(dir, timestamp, timestamp);
  }
}

describe("managed npm generation-dir loader precedence", () => {
  it("matches the authoritative generation case-insensitively on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const stateDir = tempDirs.make("openclaw-plugin-generation-precedence-");
    const newerPackageDir = writeManaged(stateDir, "3.0.0", "discord-newer-on-windows");
    const downgradedPackageDir = writeManaged(stateDir, "1.0.0");
    orderInstalls(downgradedPackageDir, newerPackageDir);
    const differentlyCasedActivePath = downgradedPackageDir.replace(
      stateDir,
      stateDir.toUpperCase(),
    );

    await seedAuthority(stateDir, differentlyCasedActivePath);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(loaded.discord).toMatchObject({ resolvedVersion: "1.0.0" });
    expect(String(loaded.discord?.installPath).toLowerCase()).toBe(
      downgradedPackageDir.toLowerCase(),
    );
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("warns when install recency replaces a dangling managed authority", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-generation-precedence-");
    const npmDir = path.join(stateDir, "npm");
    const recentPackageDir = writeManaged(stateDir, "1.0.0", "discord-recent-after-dangling");
    const olderPackageDir = writeManaged(stateDir, "9.0.0");
    orderInstalls(olderPackageDir, recentPackageDir);
    const missingPackageDir = packagePath(
      resolvePluginNpmGenerationProjectDir({
        npmDir,
        packageName: PACKAGE_NAME,
        generationKey: "discord-missing",
      }),
    );
    await seedAuthority(stateDir, missingPackageDir, true);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await expectRecovered(stateDir, recentPackageDir);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("without an authoritative active path"),
      expect.objectContaining({ code: "OPENCLAW_PLUGIN_INSTALL_RECOVERY_FALLBACK" }),
    );
  });

  it("does not treat unrelated legacy-root metadata changes as plugin recency", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-generation-precedence-");
    const recentPackageDir = writeManaged(stateDir, "1.0.0", "discord-recent-from-legacy");
    const olderPackageDir = writeManagedNpmPlugin({
      stateDir,
      ...managedPlugin,
      version: "9.0.0",
      layout: "legacy",
    });
    orderInstalls(olderPackageDir, recentPackageDir);
    writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/unrelated",
      pluginId: "unrelated",
      version: "1.0.0",
      layout: "legacy",
    });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await expectRecovered(stateDir, recentPackageDir);
  });

  it("excludes doctor-retired generations when recovering without authority", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-generation-precedence-");
    const retiredPackageDir = writeManaged(stateDir, "3.0.0", "discord-retired");
    const recoveredPackageDir = writeManaged(stateDir, "1.0.0");
    await markRetainedManagedNpmInstall({
      packageDir: retiredPackageDir,
      pluginId: PLUGIN_ID,
      reason: "test-retired-generation",
    });

    await expectRecovered(stateDir, recoveredPackageDir);
  });
});
