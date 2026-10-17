import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { BackupCreateOptions, BackupCreateResult } from "./backup-create.js";
import { requireNodeSqlite } from "./node-sqlite.js";

export function withDatabase<T>(pathname: string, run: (db: DatabaseSync) => T): T {
  const db = new (requireNodeSqlite().DatabaseSync)(pathname);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const pathname = path.join(root, relative);
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, contents);
  }
}

export async function mkdirs(...directories: string[]) {
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
}

export function withBackupFixture<T>(
  options: Parameters<typeof withOpenClawTestState>[0],
  run: (state: OpenClawTestState) => Promise<T>,
) {
  return withOpenClawTestState({ layout: "state-only", scenario: "minimal", ...options }, run);
}

export function backupCase(options: Parameters<typeof withOpenClawTestState>[0]) {
  return <Args extends unknown[]>(
    run: (state: OpenClawTestState, ...args: Args) => Promise<void>,
  ) =>
    (...args: Args) =>
      withBackupFixture(options, (state) => run(state, ...args));
}

export async function isolateBackupScratch(state: OpenClawTestState) {
  const scratchRoot = state.path("scratch");
  await fs.mkdir(scratchRoot);
  Object.assign(state.envVars, { TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot });
  state.applyEnv();
}

export function createVerifiedBackup(
  state: OpenClawTestState,
  options: BackupCreateOptions = {},
  runtime = createTestRuntime(),
) {
  return backupCreateCommand(runtime, {
    output: state.path("backup.tar.gz"),
    includeWorkspace: false,
    verify: true,
    ...options,
  });
}

export function restoreBackup(
  state: OpenClawTestState,
  archive: BackupCreateResult,
  runtime = createTestRuntime(),
) {
  return backupRestoreCommand(runtime, {
    archive: archive.archivePath,
    target: state.path("restored"),
  });
}

export async function expectVerifiedBackup(archive: BackupCreateResult) {
  await expect(
    backupVerifyCommand(createTestRuntime(), { archive: archive.archivePath }),
  ).resolves.toMatchObject({ ok: true });
}

export async function expectAbsent(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

export async function declarePluginSqliteResources(
  state: OpenClawTestState,
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
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
  try {
    inspect(database);
  } finally {
    database.close();
  }
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
  const database = new (requireNodeSqlite().DatabaseSync)(params.sqlitePath);
  const schemaVersion = params.schemaVersion ?? 1;
  try {
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
  } finally {
    database.close();
  }
}
