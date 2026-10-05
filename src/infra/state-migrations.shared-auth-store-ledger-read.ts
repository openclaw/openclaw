import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "./crypto-digest.js";
import {
  readLegacyMigrationRunsByPrefixFromDatabase,
  readLegacyMigrationSourceRunsFromDatabase,
} from "./state-migrations.receipts.js";
import {
  SHARED_AUTH_MIGRATION_KIND,
  SHARED_AUTH_MIGRATION_RECEIPT_PREFIX,
  SHARED_AUTH_MIGRATION_TABLES,
  sharedAuthMigrationRunId,
  sharedAuthMigrationRunReport,
  sharedAuthMigrationSourceReport,
  sharedAuthSourceMigrationKey,
  type SharedAuthMigrationStage,
} from "./state-migrations.shared-auth-store-codec.js";

function stage(value: string | null): SharedAuthMigrationStage | "invalid" {
  return value === "copied" || value === "ownership-flipped" || value === "completed"
    ? value
    : "invalid";
}

function count(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Fixed receipt facts are observation evidence, never migration or admission authority. */
export function inspectSharedAuthMigrationLedger(database: DatabaseSync, sourcePath: string) {
  const rows = readLegacyMigrationSourceRunsFromDatabase(database, SHARED_AUTH_MIGRATION_KIND);
  const runs = readLegacyMigrationRunsByPrefixFromDatabase(
    database,
    SHARED_AUTH_MIGRATION_RECEIPT_PREFIX,
  );
  const selected = SHARED_AUTH_MIGRATION_TABLES.map((tables) => ({
    sourceTable: tables.sourceTable,
    targetTable: tables.targetTable,
    row: rows.find(
      (row) => row.sourceKey === sharedAuthSourceMigrationKey(sourcePath, tables.sourceTable),
    ),
  }));
  const digests = selected.map(({ row }) => row?.sourceSha256);
  const expectedRun = digests.every(
    (digest): digest is string => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
  )
    ? sharedAuthMigrationRunId(digests)
    : undefined;
  const importedCount = selected.reduce(
    (total, { row }) => total + (count(row?.sourceRecordCount ?? null) ?? 0),
    0,
  );
  const sources = selected.map(({ sourceTable, targetTable, row }) => {
    if (!row) {
      return { sourceTable, targetTable, status: "missing" as const };
    }
    const sourceStage = stage(row.sourceStatus);
    const sourceSha256 =
      typeof row.sourceSha256 === "string" && /^[a-f0-9]{64}$/u.test(row.sourceSha256)
        ? row.sourceSha256
        : null;
    const sourceRecordCount = count(row.sourceRecordCount);
    const runStage = stage(row.runStatus);
    return {
      sourceTable,
      targetTable,
      status: "present" as const,
      sourcePathMatches: row.sourcePath === sourcePath,
      targetMatches: row.targetTable === targetTable,
      sourceSha256,
      sourceRecordCount,
      sourceSizeBytes: count(row.sourceSizeBytes),
      stage: sourceStage,
      removedSource: row.removedSource === 1,
      removalValid: row.removedSource === 0 || row.removedSource === 1,
      importedAt: count(row.importedAt),
      sourceReportSha256: sha256Hex(row.sourceReportJson),
      sourceReportMatches:
        sourceStage !== "invalid" &&
        sourceSha256 !== null &&
        sourceRecordCount !== null &&
        row.sourceReportJson ===
          sharedAuthMigrationSourceReport({
            source: sourceTable,
            target: targetTable,
            stage: sourceStage,
            sourceSha256,
            importedRecordCount: sourceRecordCount,
          }),
      run: {
        present: row.runId !== null,
        expectedRunMatches:
          expectedRun !== undefined && row.lastRunId === expectedRun && row.runId === expectedRun,
        stage: runStage,
        startedAt: count(row.startedAt),
        finishedAt: count(row.finishedAt),
        reportSha256: row.runReportJson === null ? null : sha256Hex(row.runReportJson),
        reportMatches:
          runStage !== "invalid" &&
          row.runReportJson === sharedAuthMigrationRunReport(runStage, importedCount),
      },
    };
  });
  const selectedKeys = new Set(selected.filter(({ row }) => row).map(({ row }) => row?.sourceKey));
  return {
    sourceCount: rows.length,
    unexpectedSourceCount: rows.filter((row) => !selectedKeys.has(row.sourceKey)).length,
    runCount: runs.length,
    unexpectedRunCount: runs.filter((run) => run.id !== expectedRun).length,
    sources,
  };
}

export type SharedAuthMigrationLedgerInspection = ReturnType<
  typeof inspectSharedAuthMigrationLedger
>;
