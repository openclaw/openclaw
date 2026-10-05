import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type MigrationReceiptDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "migration_runs" | "migration_sources"
>;

export type LegacyMigrationReceipt = {
  sourceKey: string;
  sourceSha256: string | null;
  removedSource: boolean;
  reportJson: string;
};

type LegacyMigrationRun = {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  reportJson: string;
  upsert?: boolean;
};

type LegacyMigrationSource = {
  sourceKey: string;
  migrationKind: string;
  sourcePath: string;
  targetTable: string;
  sourceSha256: string | null;
  sourceSizeBytes: number | null;
  sourceRecordCount: number | null;
  runId: string;
  status: string;
  importedAt: number;
  reportJson: string;
  upsert?: boolean;
  updateReportOnConflict?: boolean;
};

/** Source keys are persisted contracts; scoped owners hash their scope before the path. */
export function resolveLegacyMigrationSourceKey(
  prefix: string,
  sourcePath: string,
  scope?: string,
): string {
  const hash = createHash("sha256");
  if (scope !== undefined) {
    hash.update(scope).update("\0");
  }
  return `${prefix}:${hash.update(path.resolve(sourcePath)).digest("hex")}`;
}

export function readLegacyMigrationReceiptFromDatabase(
  database: DatabaseSync,
  sourceKey: string,
): LegacyMigrationReceipt | null {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .selectFrom("migration_sources")
      .select(["source_sha256", "removed_source", "report_json"])
      .where("source_key", "=", sourceKey),
  );
  return row
    ? {
        sourceKey,
        sourceSha256: row.source_sha256,
        removedSource: row.removed_source === 1,
        reportJson: row.report_json,
      }
    : null;
}

export function readLegacyMigrationReceipt(
  sourceKey: string,
  env: NodeJS.ProcessEnv,
): LegacyMigrationReceipt | null {
  return readLegacyMigrationReceiptFromDatabase(openOpenClawStateDatabase({ env }).db, sourceKey);
}

export function readLegacyMigrationRunFromDatabase(database: DatabaseSync, runId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .selectFrom("migration_runs")
      .select(["status", "report_json"])
      .where("id", "=", runId),
  );
  return row ? { status: row.status, reportJson: row.report_json } : null;
}

/** Inspection keeps missing runs visible instead of dropping their source receipts. */
export function readLegacyMigrationSourceRunsFromDatabase(
  database: DatabaseSync,
  migrationKind: string,
) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .selectFrom("migration_sources as source")
      .leftJoin("migration_runs as run", "run.id", "source.last_run_id")
      .select([
        "source.source_key as sourceKey",
        "source.source_path as sourcePath",
        "source.target_table as targetTable",
        "source.source_sha256 as sourceSha256",
        "source.source_size_bytes as sourceSizeBytes",
        "source.source_record_count as sourceRecordCount",
        "source.status as sourceStatus",
        "source.removed_source as removedSource",
        "source.imported_at as importedAt",
        "source.last_run_id as lastRunId",
        "source.report_json as sourceReportJson",
        "run.id as runId",
        "run.status as runStatus",
        "run.started_at as startedAt",
        "run.finished_at as finishedAt",
        "run.report_json as runReportJson",
      ])
      .where("source.migration_kind", "=", migrationKind),
  ).rows;
}

export function readLegacyMigrationRunsByPrefixFromDatabase(
  database: DatabaseSync,
  prefix: string,
) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .selectFrom("migration_runs")
      .select(["id", "status", "started_at", "finished_at", "report_json"])
      .where("id", "like", `${prefix}%`),
  ).rows;
}

export function recordLegacyMigrationRun(database: DatabaseSync, run: LegacyMigrationRun): void {
  const query = getNodeSqliteKysely<MigrationReceiptDatabase>(database)
    .insertInto("migration_runs")
    .values({
      id: run.runId,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      status: run.status,
      report_json: run.reportJson,
    });
  executeSqliteQuerySync(
    database,
    run.upsert
      ? query.onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            finished_at: run.finishedAt,
            status: run.status,
            report_json: run.reportJson,
          }),
        )
      : query,
  );
}

export function recordLegacyMigrationSource(
  database: DatabaseSync,
  source: LegacyMigrationSource,
): void {
  const query = getNodeSqliteKysely<MigrationReceiptDatabase>(database)
    .insertInto("migration_sources")
    .values({
      source_key: source.sourceKey,
      migration_kind: source.migrationKind,
      source_path: source.sourcePath,
      target_table: source.targetTable,
      source_sha256: source.sourceSha256,
      source_size_bytes: source.sourceSizeBytes,
      source_record_count: source.sourceRecordCount,
      last_run_id: source.runId,
      status: source.status,
      imported_at: source.importedAt,
      removed_source: 0,
      report_json: source.reportJson,
    });
  executeSqliteQuerySync(
    database,
    source.upsert
      ? query.onConflict((conflict) =>
          conflict.column("source_key").doUpdateSet({
            source_sha256: source.sourceSha256,
            source_size_bytes: source.sourceSizeBytes,
            source_record_count: source.sourceRecordCount,
            last_run_id: source.runId,
            status: source.status,
            imported_at: source.importedAt,
            removed_source: 0,
            ...(source.updateReportOnConflict === false ? {} : { report_json: source.reportJson }),
          }),
        )
      : query,
  );
}

/** Insert run and source together inside the caller's existing synchronous transaction. */
export function recordLegacyMigrationReceipt(
  database: DatabaseSync,
  receipt: Omit<LegacyMigrationSource, "status" | "importedAt" | "updateReportOnConflict"> & {
    now: number;
  },
): void {
  recordLegacyMigrationRun(database, {
    runId: receipt.runId,
    startedAt: receipt.now,
    finishedAt: receipt.now,
    status: "completed",
    reportJson: receipt.reportJson,
    upsert: receipt.upsert,
  });
  recordLegacyMigrationSource(database, {
    ...receipt,
    status: "completed",
    importedAt: receipt.now,
  });
}

/** The caller owns the transaction and its live mutation admission. */
export function markLegacyMigrationSourceRemovedInDatabase(
  database: DatabaseSync,
  sourceKey: string,
): void {
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<MigrationReceiptDatabase>(database)
      .updateTable("migration_sources")
      .set({ removed_source: 1 })
      .where("source_key", "=", sourceKey),
  );
}

export function markLegacyMigrationSourceRemoved(
  sourceKey: string,
  env: NodeJS.ProcessEnv,
  operationLabel?: string,
  assertCurrent?: () => void,
): void {
  assertCurrent?.();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent?.();
      markLegacyMigrationSourceRemovedInDatabase(db, sourceKey);
      assertCurrent?.();
    },
    { env },
    operationLabel ? { operationLabel } : {},
  );
}
