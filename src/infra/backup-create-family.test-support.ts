import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";

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
