import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  type OpenClawTestState as State,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { BackupCreateOptions, BackupCreateResult } from "./backup-create.js";
import { requireNodeSqlite } from "./node-sqlite.js";

type FixtureOptions = Parameters<typeof withOpenClawTestState>[0];

export function withDatabase<T>(pathname: string, run: (db: DatabaseSync) => T): T {
  using db = new (requireNodeSqlite().DatabaseSync)(pathname);
  return run(db);
}

export async function mkdirs(...directories: string[]) {
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
}

export const withBackupFixture = <T>(options: FixtureOptions, run: (state: State) => Promise<T>) =>
  withOpenClawTestState({ layout: "state-only", scenario: "minimal", ...options }, run);

export function backupCase(options: FixtureOptions) {
  return <Args extends unknown[]>(run: (state: State, ...args: Args) => Promise<void>) =>
    (...args: Args) =>
      withBackupFixture(options, (state) => run(state, ...args));
}

export async function isolateBackupScratch(state: State) {
  const scratchRoot = state.path("scratch");
  await fs.mkdir(scratchRoot);
  Object.assign(state.envVars, { TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot });
  state.applyEnv();
}

export const createVerifiedBackup = (
  state: State,
  options: BackupCreateOptions = {},
  runtime = createTestRuntime(),
) =>
  backupCreateCommand(runtime, {
    output: state.path("backup.tar.gz"),
    includeWorkspace: false,
    verify: true,
    ...options,
  });

export const restoreBackup = (
  state: State,
  archive: BackupCreateResult,
  runtime = createTestRuntime(),
) =>
  backupRestoreCommand(runtime, {
    archive: archive.archivePath,
    target: state.path("restored"),
  });

export const expectAbsent = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

export async function declarePluginSqliteResources(
  state: State,
  relativePath = "plugins/dedicated",
) {
  const rootDir = state.path("synthetic-backup-plugin");
  await fs.mkdir(rootDir, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId: "backup-owner",
    manifest: {
      backupResources: [{ disposition: "include", scope: "state", relativePath }],
    },
  });
  await state.writeConfig(createColdPluginConfig(rootDir, fixture.pluginId));
}

export function inspectDatabase(databasePath: string, inspect: (database: DatabaseSync) => void) {
  using database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
  inspect(database);
}

export function expectDatabaseRows(databasePath: string, sql: string, rows: unknown) {
  inspectDatabase(databasePath, (database) => expect(database.prepare(sql).all()).toEqual(rows));
}

export function createOwnedSqliteDatabase(params: {
  sqlitePath: string;
  role: "agent" | "global";
  agentId?: string;
  schemaVersion?: number;
}): void {
  using database = new (requireNodeSqlite().DatabaseSync)(params.sqlitePath);
  const schemaVersion = params.schemaVersion ?? 1;
  database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
        agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${schemaVersion};
    `);
  database
    .prepare(`INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', ?, ?, ?, NULL, 1, 1)`)
    .run(params.role, schemaVersion, params.agentId ?? null);
}
