import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../../plugins/test-helpers/fs-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "./installed-plugin-index-path.js";
import {
  importLegacyInstalledPluginIndexFileToSqlite,
  legacyInstalledPluginIndexFileExists,
} from "./installed-plugin-index.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-doctor-installed-plugin-index", tempDirs);
}

function createIndex(overrides: Partial<InstalledPluginIndex> = {}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        enabled: true,
        syntheticAuthRefs: ["demo"],
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function writeLegacyIndex(stateDir: string, value: unknown): string {
  const filePath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

describe("legacy installed plugin index migration", () => {
  it("resolves the legacy index path under the state plugins directory", () => {
    const stateDir = makeTempDir();

    expect(resolveLegacyInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "plugins", "installs.json"),
    );
  });

  it("imports legacy JSON without preserving prototype poison keys", async () => {
    const stateDir = makeTempDir();
    const index = createIndex({
      installRecords: {
        demo: {
          source: "npm",
          spec: "demo@1.0.0",
        },
      },
    });
    Object.defineProperty(index, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    Object.defineProperty(index.installRecords, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const filePath = writeLegacyIndex(stateDir, index);

    expect(legacyInstalledPluginIndexFileExists({ stateDir })).toBe(true);
    expect(importLegacyInstalledPluginIndexFileToSqlite({ stateDir })).toMatchObject({
      imported: true,
      plugins: 1,
      installRecords: 1,
      removedSource: true,
    });
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });

    expect(persisted).toMatchObject({
      plugins: [expect.objectContaining({ pluginId: "demo" })],
      installRecords: {
        demo: expect.objectContaining({ source: "npm" }),
      },
    });
    expect(Object.prototype.hasOwnProperty.call(persisted as object, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(persisted?.installRecords ?? {}, "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(legacyInstalledPluginIndexFileExists({ stateDir })).toBe(false);
  });

  it("ignores invalid legacy indexes during import", async () => {
    const stateDir = makeTempDir();
    writeLegacyIndex(stateDir, { version: 999 });

    expect(importLegacyInstalledPluginIndexFileToSqlite({ stateDir })).toMatchObject({
      imported: false,
    });
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("rejects pre-migration legacy indexes so update can rebuild them", async () => {
    const stateDir = makeTempDir();
    const legacyIndex = createIndex();
    delete (legacyIndex as unknown as Record<string, unknown>).migrationVersion;
    writeLegacyIndex(stateDir, legacyIndex);

    expect(importLegacyInstalledPluginIndexFileToSqlite({ stateDir })).toMatchObject({
      imported: false,
    });
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });
});
