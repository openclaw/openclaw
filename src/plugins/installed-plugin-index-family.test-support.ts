import assert from "node:assert/strict";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

function assertIndexRow(row: Record<string, SQLOutputValue>): asserts row is {
  state_key: string;
  value_json: string;
  updated_at_ms: number;
} {
  assert(typeof row.state_key === "string");
  assert(typeof row.value_json === "string");
  assert(typeof row.updated_at_ms === "number");
}

/** Independent native reads observe durable rows without consuming metadata caches. */
export function readIndexRow(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT state_key, value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
      )
      .get();
    if (row) {
      assertIndexRow(row);
    }
    return row;
  } finally {
    database.close();
  }
}

export function indexStoreFixture(stateDir: string, callerEnv: NodeJS.ProcessEnv = process.env) {
  const env = { ...callerEnv, OPENCLAW_STATE_DIR: stateDir };
  const options = { stateDir, env };
  const databasePath = resolveInstalledPluginIndexStorePath(options);
  const transaction = <T>(run: Parameters<typeof runOpenClawStateWriteTransaction<T>>[0]) =>
    runOpenClawStateWriteTransaction(run, { env, path: databasePath });
  const row = () => readIndexRow(databasePath) ?? null;
  return {
    ...options,
    databasePath,
    row,
    transaction,
    sql: (sql: string, ...values: SQLInputValue[]) =>
      transaction(({ db }) => db.prepare(sql).run(...values)),
    exec: (sql: string) => transaction(({ db }) => db.exec(sql)),
    revision: () => {
      const value: unknown = JSON.parse(row()?.value_json ?? "null");
      assert(value && typeof value === "object" && "revision" in value);
      assert(typeof value.revision === "number");
      return value.revision;
    },
    read: () => readPersistedInstalledPluginIndex(options),
    write: (index: InstalledPluginIndex) => writePersistedInstalledPluginIndex(index, options),
  };
}
