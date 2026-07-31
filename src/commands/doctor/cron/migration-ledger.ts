// Durable receipts make legacy cron migration retries independent of mutable runtime rows.
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../../infra/node-sqlite.js";
import type { DB as OpenClawStateDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import type { LegacyCronMigrationSource } from "./legacy-store-migration.js";

type CronMigrationDatabase = Pick<OpenClawStateDatabase, "migration_runs" | "migration_sources">;

function migrationRunId(source: LegacyCronMigrationSource): string {
  return `cron-legacy:${source.sourceKey}`;
}

function hasLegacyCronMigrationReceiptInDatabase(
  db: DatabaseSync,
  source: LegacyCronMigrationSource,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<CronMigrationDatabase>(db)
      .selectFrom("migration_sources")
      .select("status")
      .where("source_key", "=", source.sourceKey),
  );
  return row?.status === "completed";
}

export function hasLegacyCronMigrationReceipt(
  source: LegacyCronMigrationSource,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasLegacyCronMigrationReceiptInDatabase(openOpenClawStateDatabase({ env }).db, source);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

export function hasLegacyCronMigrationReceiptReadOnly(
  source: LegacyCronMigrationSource,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return false;
  }
  const db = openNodeSqliteDatabase(statePath, { readOnly: true });
  try {
    if (!tableExists(db, "migration_sources")) {
      return false;
    }
    return hasLegacyCronMigrationReceiptInDatabase(db, source);
  } finally {
    db.close();
  }
}

export function acquireLegacyCronMigrationReceipt(
  db: DatabaseSync,
  source: LegacyCronMigrationSource,
): boolean {
  if (hasLegacyCronMigrationReceiptInDatabase(db, source)) {
    return false;
  }
  const now = Date.now();
  const runId = migrationRunId(source);
  const reportJson = JSON.stringify({
    source: "legacy-cron-json",
    target: "cron_jobs",
    statePath: source.stateSha256 ? source.statePath : undefined,
    stateSha256: source.stateSha256,
  });
  const kysely = getNodeSqliteKysely<CronMigrationDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("migration_runs")
      .values({
        id: runId,
        started_at: now,
        finished_at: now,
        status: "completed",
        report_json: reportJson,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          finished_at: now,
          status: "completed",
          report_json: reportJson,
        }),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("migration_sources")
      .values({
        source_key: source.sourceKey,
        migration_kind: "legacy-cron-json",
        source_path: source.sourcePath,
        target_table: "cron_jobs",
        source_sha256: source.sourceSha256,
        source_size_bytes: source.sourceSizeBytes,
        source_record_count: source.sourceRecordCount,
        last_run_id: runId,
        status: "completed",
        imported_at: now,
        removed_source: 0,
        report_json: reportJson,
      })
      .onConflict((conflict) =>
        conflict.column("source_key").doUpdateSet({
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      ),
  );
  return true;
}

/** Removes a receipt created by a config write whose cron import was rolled back. */
export function rollbackLegacyCronMigrationReceiptInDatabase(
  db: DatabaseSync,
  source: LegacyCronMigrationSource,
): void {
  const kysely = getNodeSqliteKysely<CronMigrationDatabase>(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("migration_sources")
      .select(["migration_kind", "last_run_id", "removed_source", "source_sha256", "status"])
      .where("source_key", "=", source.sourceKey),
  );
  if (
    current?.migration_kind !== "legacy-cron-json" ||
    current.last_run_id !== migrationRunId(source) ||
    current.removed_source !== 0 ||
    current.source_sha256 !== source.sourceSha256 ||
    current.status !== "completed"
  ) {
    throw new Error("legacy cron migration receipt changed after import; refusing stale rollback");
  }
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("migration_sources").where("source_key", "=", source.sourceKey),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("migration_runs").where("id", "=", migrationRunId(source)),
  );
}

/** Removes a receipt created by a config write whose cron import was rolled back. */
export function rollbackLegacyCronMigrationReceipt(
  source: LegacyCronMigrationSource,
  env: NodeJS.ProcessEnv = process.env,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => rollbackLegacyCronMigrationReceiptInDatabase(db, source),
    { env },
  );
}

export function markLegacyCronMigrationSourceRemoved(source: LegacyCronMigrationSource): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronMigrationDatabase>(db)
        .updateTable("migration_sources")
        .set({ removed_source: 1 })
        .where("source_key", "=", source.sourceKey),
    );
  });
}
