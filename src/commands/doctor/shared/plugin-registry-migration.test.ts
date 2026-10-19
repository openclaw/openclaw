import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
} from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../../plugins/test-helpers/fs-fixtures.js";
import {
  createInstalledPluginIndex,
  createInstalledPluginIndexCandidate,
} from "../../../plugins/test-helpers/installed-plugin-index.js";
import * as stateDbReadOnly from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../../test-utils/database-cleanup.js";
import { migratePluginRegistryForDoctor } from "./plugin-registry-migration.js";
const tempDirs: string[] = [];

afterEach(async () => {
  await closeStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-migration", tempDirs);
}

function requireMigratedIndex(
  result: Awaited<ReturnType<typeof migratePluginRegistryForDoctor>>,
): InstalledPluginIndex {
  if (result.status !== "migrated") {
    throw new Error(`Expected migration result to be migrated, got ${result.status}`);
  }
  return result.current;
}

function migrate(
  stateDir: string,
  options: Parameters<typeof migratePluginRegistryForDoctor>[0] = {},
) {
  return migratePluginRegistryForDoctor({
    stateDir,
    env: { OPENCLAW_BUNDLED_PLUGINS_DIR: undefined, OPENCLAW_VERSION: "2026.4.25", VITEST: "true" },
    ...options,
  });
}

function readRow(stateDir: string) {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
        )
        .get(),
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
}

function insertStalePersistedIndexRow(stateDir: string, installRecordsJson = "{}") {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const valueJson = JSON.stringify({
        revision: 123,
        index: {
          ...createInstalledPluginIndex({ plugins: [] }),
          warning: null,
          migrationVersion: 0,
          policyHash: "stale-policy",
          generatedAtMs: 123,
          installRecords: JSON.parse(installRecordsJson) as unknown,
        },
      });
      db.prepare(
        `
          INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('plugins.installedIndex', ?, 123)
        `,
      ).run(valueJson);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

it("stops migration with the original error when the shared registry read fails", async () => {
  const stateDir = makeTempDir();
  const records = { authoritative: { source: "npm", spec: "authoritative@1.0.0" } };
  insertStalePersistedIndexRow(stateDir, JSON.stringify(records));
  const error = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
  readSpy.mockImplementationOnce(() => {
    throw error;
  });
  const readConfig = vi.fn(() => ({}));
  await expect.soft(migrate(stateDir, { readConfig, candidates: [] })).rejects.toBe(error);
  expect.soft(readConfig).not.toHaveBeenCalled();
  expect(readSpy).toHaveBeenCalledOnce();
  readSpy.mockRestore();
  const row = readRow(stateDir);
  expect(row).toMatchObject({ updated_at_ms: 123 });
  const restored = await migrate(stateDir, { readConfig, candidates: [] });
  expect(requireMigratedIndex(restored).installRecords).toEqual(records);
});

it.each(["skip-existing", "dry-run"] as const)(
  "performs %s without reading config",
  async (status) => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    if (status === "skip-existing") {
      await writePersistedInstalledPluginIndex(createInstalledPluginIndex({ plugins: [] }), {
        stateDir,
      });
    }
    const readConfig = vi.fn(async () => ({}));
    const result = await migrate(stateDir, { readConfig, dryRun: status === "dry-run" });
    expect(result).toMatchObject({
      status,
      migrated: false,
      preflight: { action: status === "dry-run" ? "initialize" : "skip-existing", filePath },
    });
    expect(readConfig).not.toHaveBeenCalled();
    if (status === "dry-run") {
      expect(fs.existsSync(path.join(stateDir, "plugins", "installs.json"))).toBe(false);
    }
  },
);

it("rejects invalid SQLite install records without rewriting the row", async () => {
  const stateDir = makeTempDir();
  const installRecordsJson = '{"__proto__":{"source":"bogus"}}';
  insertStalePersistedIndexRow(stateDir, installRecordsJson);

  await expect(migrate(stateDir, { readConfig: async () => ({}) })).rejects.toThrow(
    "delete only the config_machine_state row with state_key='plugins.installedIndex'",
  );

  const row = readRow(stateDir) as { value_json: string; updated_at_ms: number | bigint };
  expect(row.updated_at_ms).toBe(123);
  const persistedValue = JSON.parse(row.value_json) as {
    index: { migrationVersion: number; installRecords: unknown };
  };
  expect(persistedValue.index.migrationVersion).toBe(0);
  expect(JSON.stringify(persistedValue.index.installRecords)).toBe(
    JSON.stringify(JSON.parse(installRecordsJson)),
  );
});

it("builds missing registry state from discovered plugin manifests", async () => {
  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "plugins", "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  const candidate = createInstalledPluginIndexCandidate(pluginDir);

  const result = await migrate(stateDir, { candidates: [candidate], config: {} });
  expect(result).toMatchObject({
    status: "migrated",
    migrated: true,
    preflight: { action: "initialize" },
  });
  const current = requireMigratedIndex(result);
  expect(current).toMatchObject({
    refreshReason: "migration",
    migrationVersion: 1,
    plugins: expect.arrayContaining([expect.objectContaining({ pluginId: "demo" })]),
  });

  const persisted = await readPersistedInstalledPluginIndex({ stateDir });
  expect(persisted).toMatchObject({
    refreshReason: "migration",
    plugins: expect.arrayContaining([expect.objectContaining({ pluginId: "demo" })]),
  });
});
