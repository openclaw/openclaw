import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export type ReservedKeyRename = { from: string; to: string };

const REPAIR_JOURNAL_SCOPE = "doctor-session-key-migration";
const REPAIR_JOURNAL_KEY = "reserved-incognito-v1";

type SharedStateSessionKeyColumn = {
  column: string;
  json: boolean;
  table: string;
};

// Shared state has many owner-specific session-key columns; schema discovery keeps this migration complete.
function listSharedStateSessionKeyColumns(database: DatabaseSync): SharedStateSessionKeyColumn[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables.flatMap(({ name: table }) => {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`)
      .all() as Array<{ name: string }>;
    return columns.flatMap(({ name: column }): SharedStateSessionKeyColumn[] => {
      if (column === "session_key" || column.endsWith("_session_key")) {
        return [{ table, column, json: false }];
      }
      return column.endsWith("_session_keys_json") ? [{ table, column, json: true }] : [];
    });
  });
}

export function collectSharedStateSessionKeys(database: DatabaseSync): Set<string> {
  const keys = new Set<string>();
  for (const { table, column, json } of listSharedStateSessionKeyColumns(database)) {
    const rows = database
      .prepare(
        `SELECT ${quoteSqliteIdentifier(column)} AS value FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(column)} IS NOT NULL`,
      )
      .all() as Array<{ value: unknown }>;
    for (const { value } of rows) {
      if (!json && typeof value === "string") {
        keys.add(value);
      } else if (json && typeof value === "string") {
        try {
          collectJsonStringValues(JSON.parse(value), keys);
        } catch {
          // Existing integrity checks own malformed shared-state JSON.
        }
      }
    }
  }
  return keys;
}

export function rewriteSharedStateSessionKeys(
  database: DatabaseSync,
  renames: ReadonlyMap<string, string>,
): void {
  for (const { table, column, json } of listSharedStateSessionKeyColumns(database)) {
    const quotedTable = quoteSqliteIdentifier(table);
    const quotedColumn = quoteSqliteIdentifier(column);
    if (!json) {
      const statement = database.prepare(
        `UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE ${quotedColumn} = ?`,
      );
      for (const [from, to] of renames) {
        statement.run(to, from);
      }
      continue;
    }
    const rows = database
      .prepare(`SELECT rowid, ${quotedColumn} AS value FROM ${quotedTable}`)
      .all() as Array<{ rowid: number | bigint; value: unknown }>;
    const update = database.prepare(
      `UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`,
    );
    for (const row of rows) {
      if (typeof row.value !== "string") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      const rewritten = JSON.stringify(replaceSessionKeyReferences(parsed, renames));
      if (rewritten !== row.value) {
        update.run(rewritten, row.rowid);
      }
    }
  }
}

function collectJsonStringValues(value: unknown, values: Set<string>): void {
  if (typeof value === "string") {
    values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStringValues(item, values);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    collectJsonStringValues(item, values);
  }
}

export function readRepairJournal(database: DatabaseSync): ReservedKeyRename[] {
  const row = database
    .prepare("SELECT payload_json FROM state_leases WHERE scope = ? AND lease_key = ?")
    .get(REPAIR_JOURNAL_SCOPE, REPAIR_JOURNAL_KEY) as { payload_json: string | null } | undefined;
  if (!row?.payload_json) {
    return [];
  }
  const parsed = JSON.parse(row.payload_json) as { renames?: unknown; version?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.renames)) {
    throw new Error("Invalid reserved incognito session key repair journal");
  }
  return parsed.renames.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as { from?: unknown }).from !== "string" ||
      typeof (item as { to?: unknown }).to !== "string"
    ) {
      throw new Error("Invalid reserved incognito session key repair journal entry");
    }
    return { from: (item as { from: string }).from, to: (item as { to: string }).to };
  });
}

export function readRepairJournalReadOnly(env: NodeJS.ProcessEnv): ReservedKeyRename[] {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return [];
  }
  return withOpenClawStateDatabaseReadOnly((database) => readRepairJournal(database.db), {
    env,
    path: statePath,
  });
}

export function writeRepairJournal(
  database: DatabaseSync,
  renames: readonly ReservedKeyRename[],
): void {
  const now = Date.now();
  database
    .prepare(
      "INSERT INTO state_leases (scope, lease_key, owner, payload_json, created_at, updated_at) VALUES (?, ?, 'openclaw-doctor', ?, ?, ?) ON CONFLICT(scope, lease_key) DO UPDATE SET owner = excluded.owner, payload_json = excluded.payload_json, updated_at = excluded.updated_at",
    )
    .run(
      REPAIR_JOURNAL_SCOPE,
      REPAIR_JOURNAL_KEY,
      JSON.stringify({ version: 1, renames }),
      now,
      now,
    );
}

export function deleteRepairJournal(database: DatabaseSync): void {
  database
    .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
    .run(REPAIR_JOURNAL_SCOPE, REPAIR_JOURNAL_KEY);
}

function replaceSessionKeyReferences(
  value: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return renames.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionKeyReferences(item, renames));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceSessionKeyReferences(item, renames)]),
  );
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
