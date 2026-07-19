import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { DURABLE_RUNTIME_SCHEMA_SQL } from "./schema.generated.js";

export const DURABLE_RUNTIME_SCHEMA_VERSION = 1;
export const DURABLE_RUNTIME_SCHEMA_META_KEY = "durable_runtime";

const DURABLE_RUNTIME_TABLES = [
  "durable_execution_records",
  "durable_event_evidence",
  "durable_execution_steps",
  "durable_payload_refs",
  "durable_run_correlations",
  "durable_timer_obligations",
  "durable_signal_evidence",
  "wake_obligations",
  "uncertainty_facts",
  "delivery_attempt_evidence",
] as const;

type DurableSchemaMetadataRow = {
  schema_version?: unknown;
};

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

function readDurableSchemaVersion(db: DatabaseSync): number | undefined {
  if (!hasTable(db, "schema_meta")) {
    return undefined;
  }
  const row = db
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = ?")
    .get(DURABLE_RUNTIME_SCHEMA_META_KEY) as DurableSchemaMetadataRow | undefined;
  if (!row) {
    return undefined;
  }
  const version = Number(row.schema_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Durable runtime schema metadata is invalid: ${String(row.schema_version)}`);
  }
  return version;
}

function assertSupportedDurableSchemaVersion(db: DatabaseSync, pathname: string): void {
  const version = readDurableSchemaVersion(db);
  if (version !== undefined && version > DURABLE_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `Durable runtime database ${pathname} uses newer schema version ${version}; this OpenClaw build supports ${DURABLE_RUNTIME_SCHEMA_VERSION}.`,
    );
  }
}

/** Fail before the shared-state owner can mutate a database from a newer durable schema. */
export function assertDurableRuntimeSchemaVersionAtPath(pathname: string): void {
  if (!existsSync(pathname)) {
    return;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    assertSupportedDurableSchemaVersion(db, pathname);
  } finally {
    db.close();
  }
}

/** Open an already-installed durable schema without creating or migrating state. */
export function openDurableRuntimeSchemaReadOnly(pathname: string): DatabaseSync {
  if (!existsSync(pathname)) {
    throw new Error(`Durable runtime database ${pathname} is not initialized.`);
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    assertSupportedDurableSchemaVersion(db, pathname);
    const version = readDurableSchemaVersion(db);
    if (version !== DURABLE_RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `Durable runtime database ${pathname} is not initialized at schema version ${DURABLE_RUNTIME_SCHEMA_VERSION}.`,
      );
    }
    const missingTable = DURABLE_RUNTIME_TABLES.find((tableName) => !hasTable(db, tableName));
    if (missingTable) {
      throw new Error(
        `Durable runtime database ${pathname} is missing required table ${missingTable}.`,
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Install or migrate the optional durable schema inside the shared state database. */
export function ensureDurableRuntimeSchema(db: DatabaseSync, pathname: string): void {
  assertSupportedDurableSchemaVersion(db, pathname);
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(DURABLE_RUNTIME_SCHEMA_SQL);
    const now = Date.now();
    db.prepare(
      `INSERT INTO schema_meta (
         meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(meta_key) DO UPDATE SET
         role = excluded.role,
         schema_version = excluded.schema_version,
         agent_id = NULL,
         app_version = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      DURABLE_RUNTIME_SCHEMA_META_KEY,
      "durable_runtime",
      DURABLE_RUNTIME_SCHEMA_VERSION,
      now,
      now,
    );
  });
}
