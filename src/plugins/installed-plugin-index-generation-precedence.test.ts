// Covers loader precedence between a plugin's flat project dir and newer
// `__openclaw-generation__` dirs when reconciling persisted install records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const PACKAGE_NAME = "@openclaw/discord";
const PLUGIN_ID = "discord";
const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-generation-precedence-"));
  tempDirs.push(dir);
  return dir;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

/** Writes a managed plugin version into an `__openclaw-generation__` dir. */
function writeManagedGeneration(params: {
  stateDir: string;
  version: string;
  generationKey: string;
}): string {
  const npmDir = path.join(params.stateDir, "npm");
  writeManagedNpmPlugin({
    stateDir: params.stateDir,
    packageName: PACKAGE_NAME,
    pluginId: PLUGIN_ID,
    version: params.version,
  });
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  const generationProjectRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName: PACKAGE_NAME,
    generationKey: params.generationKey,
  });
  fs.renameSync(flatProjectRoot, generationProjectRoot);
  return path.join(generationProjectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

/** Writes a managed plugin version into the flat project dir and leaves it there. */
function writeManagedFlat(stateDir: string, version: string): string {
  const npmDir = path.join(stateDir, "npm");
  writeManagedNpmPlugin({ stateDir, packageName: PACKAGE_NAME, pluginId: PLUGIN_ID, version });
  const flatProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName: PACKAGE_NAME });
  return path.join(flatProjectRoot, "node_modules", ...PACKAGE_NAME.split("/"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("managed npm generation-dir loader precedence", () => {
  it("repoints to a newer managed generation when the persisted install still exists", async () => {
    const stateDir = makeStateDir();
    const staleVersion = "2026.6.11";
    const activeVersion = "2026.7.1";

    const activePackageDir = writeManagedGeneration({
      stateDir,
      version: activeVersion,
      generationKey: `discord-${activeVersion}`,
    });
    // Recreate the prior version at the flat project dir so it is still present
    // on disk (the case `isUnavailableManagedNpmInstallRecord` does not cover).
    const stalePackageDir = writeManagedFlat(stateDir, staleVersion);

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@latest`,
          installPath: stalePackageDir,
          version: staleVersion,
          resolvedName: PACKAGE_NAME,
          resolvedVersion: staleVersion,
          resolvedSpec: `${PACKAGE_NAME}@${staleVersion}`,
          integrity: "sha512-stale",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    const record = expectRecordFields(loaded.discord, {
      source: "npm",
      spec: `${PACKAGE_NAME}@latest`,
      installPath: activePackageDir,
      version: activeVersion,
      resolvedName: PACKAGE_NAME,
      resolvedVersion: activeVersion,
      resolvedSpec: `${PACKAGE_NAME}@${activeVersion}`,
    });
    expect(record.integrity).toBeUndefined();

    clearLoadInstalledPluginIndexInstallRecordsCache();
    expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).discord, {
      installPath: activePackageDir,
      resolvedVersion: activeVersion,
    });
  });

  it("adopts the highest version when several generations are present", async () => {
    const stateDir = makeStateDir();
    // On-disk order of generation dirs is hash-based, so this pins that recovery
    // selects by version rather than by whichever project root sorts last.
    writeManagedGeneration({ stateDir, version: "2.0.0", generationKey: "discord-two" });
    const newestPackageDir = writeManagedGeneration({
      stateDir,
      version: "3.0.0",
      generationKey: "discord-three",
    });
    const stalePackageDir = writeManagedFlat(stateDir, "1.0.0");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@1.0.0`,
          installPath: stalePackageDir,
          version: "1.0.0",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "1.0.0",
          resolvedSpec: `${PACKAGE_NAME}@1.0.0`,
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: newestPackageDir,
      resolvedVersion: "3.0.0",
    });
  });

  it("keeps a current managed install when only an older generation lingers", async () => {
    const stateDir = makeStateDir();
    writeManagedGeneration({ stateDir, version: "2026.6.11", generationKey: "discord-stale" });
    const activePackageDir = writeManagedFlat(stateDir, "2026.7.1");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@2026.7.1`,
          installPath: activePackageDir,
          version: "2026.7.1",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "2026.7.1",
          resolvedSpec: `${PACKAGE_NAME}@2026.7.1`,
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
  });

  it("does not repoint an intentional custom npm install outside the managed root", async () => {
    const stateDir = makeStateDir();
    // A managed generation with a higher version exists on disk...
    writeManagedGeneration({ stateDir, version: "2.0.0", generationKey: "discord-managed" });
    // ...but the persisted record points at a custom install outside the npm root.
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: `${PACKAGE_NAME}@beta`,
          installPath: customInstallPath,
          version: "1.0.0",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: "1.0.0",
          resolvedSpec: `${PACKAGE_NAME}@1.0.0`,
          integrity: "sha512-custom",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: `${PACKAGE_NAME}@beta`,
      installPath: customInstallPath,
      resolvedVersion: "1.0.0",
      integrity: "sha512-custom",
    });
  });
});
