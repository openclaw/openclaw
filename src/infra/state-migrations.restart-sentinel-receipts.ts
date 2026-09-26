import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { RestartSentinelPayload } from "./restart-sentinel-store.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  readLegacyMigrationRunFromDatabase,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";

export const MIGRATION_KIND = "legacy-restart-sentinel-json";

const MIGRATION_DECISIONS = [
  "canonical-preserved",
  "canonical-advanced",
  "legacy-update-finalized",
  "invalid-canonical-repaired",
  "legacy-imported",
  "malformed-legacy-discarded",
  "receipt-authoritative",
] as const;
export type RestartSentinelMigrationDecision = (typeof MIGRATION_DECISIONS)[number];

export type CanonicalImport = { sourceSha256: string; revision: number };

function readReceiptReport(reportJson: string, expectedSha256?: string | null) {
  const report = safeParseJson(reportJson);
  if (
    !isRecord(report) ||
    report.source !== MIGRATION_KIND ||
    report.target !== "gateway_restart_sentinel" ||
    typeof report.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.sourceSha256) ||
    (expectedSha256 !== undefined && report.sourceSha256 !== expectedSha256) ||
    typeof report.sourceValid !== "boolean" ||
    (report.importedRecordCount !== 0 && report.importedRecordCount !== 1) ||
    (report.preservedSqliteRecordCount !== 0 && report.preservedSqliteRecordCount !== 1) ||
    typeof report.decision !== "string" ||
    !MIGRATION_DECISIONS.some((decision) => decision === report.decision)
  ) {
    throw new Error("Restart sentinel migration receipt is invalid; preserve it for recovery.");
  }
  return report;
}

/** Preserve the path-wide tombstone recorded by the published v2026.9.5 importer. */
export function hasLegacyPathWideReceipt(receipt: LegacyMigrationReceipt): boolean {
  const report = readReceiptReport(receipt.reportJson, receipt.sourceSha256);
  if (
    Object.hasOwn(report, "importedRevision") ||
    Object.hasOwn(report, "pendingHandoffId") ||
    Object.hasOwn(report, "canonicalImport")
  ) {
    return false;
  }
  switch (report.decision) {
    case "canonical-preserved":
      return (
        report.sourceValid === true &&
        report.importedRecordCount === 0 &&
        report.preservedSqliteRecordCount === 1
      );
    case "malformed-legacy-discarded":
      return (
        report.sourceValid === false &&
        report.importedRecordCount === 0 &&
        report.preservedSqliteRecordCount === 0
      );
    case "receipt-authoritative":
      return report.importedRecordCount === 0 && report.preservedSqliteRecordCount === 0;
    case "legacy-imported":
    case "invalid-canonical-repaired":
      return (
        report.sourceValid === true &&
        report.importedRecordCount === 1 &&
        report.preservedSqliteRecordCount === 0
      );
    default:
      return false;
  }
}

export function hasImportedPendingHandoff(
  db: DatabaseSync,
  sourceKey: string,
  handoffId: string,
): boolean {
  // Only a new legacy marker needs this historical lookup; ordinary pending retries have no file.
  const record = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "migration_runs">>(db)
      .selectFrom("migration_runs")
      .select("id")
      .where("id", ">=", `${sourceKey}:`)
      .where("id", "<", `${sourceKey};`)
      .where("status", "=", "completed")
      .where(
        (eb) =>
          eb.fn<string>("json_extract", [eb.ref("report_json"), eb.val("$.pendingHandoffId")]),
        "=",
        handoffId,
      )
      .where(
        (eb) =>
          eb.fn<number>("json_extract", [eb.ref("report_json"), eb.val("$.importedRecordCount")]),
        "=",
        1,
      )
      .where(
        (eb) => eb.fn<string>("json_extract", [eb.ref("report_json"), eb.val("$.source")]),
        "=",
        MIGRATION_KIND,
      )
      .where(
        (eb) => eb.fn<string>("json_extract", [eb.ref("report_json"), eb.val("$.target")]),
        "=",
        "gateway_restart_sentinel",
      )
      .limit(1),
  );
  return record !== undefined;
}

export function sourceRunId(sourceKey: string, sha256: string): string {
  return `${sourceKey}:${sha256.slice(0, 16)}`;
}

export function readSourceDecision(db: DatabaseSync, sourceKey: string, sha256: string): boolean {
  const latest = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
  if (latest?.sourceSha256 === sha256) {
    readReceiptReport(latest.reportJson, sha256);
    return true;
  }
  const run = readLegacyMigrationRunFromDatabase(db, sourceRunId(sourceKey, sha256));
  const report = run?.status === "completed" ? readReceiptReport(run.reportJson) : undefined;
  return report?.sourceSha256 === sha256;
}

export function readCanonicalImport(
  db: DatabaseSync,
  sourceKey: string,
  reportJson: string | undefined,
  revision: number,
): CanonicalImport | undefined {
  const report = reportJson ? safeParseJson(reportJson) : undefined;
  if (!isRecord(report)) {
    return undefined;
  }
  const pointer =
    report.importedRevision === revision
      ? { sourceSha256: report.sourceSha256, revision }
      : report.canonicalImport;
  if (
    !isRecord(pointer) ||
    pointer.revision !== revision ||
    typeof pointer.sourceSha256 !== "string"
  ) {
    return undefined;
  }
  const run = readLegacyMigrationRunFromDatabase(db, sourceRunId(sourceKey, pointer.sourceSha256));
  const original = run?.status === "completed" ? safeParseJson(run.reportJson) : undefined;
  if (
    !isRecord(original) ||
    original.source !== MIGRATION_KIND ||
    original.target !== "gateway_restart_sentinel" ||
    original.sourceSha256 !== pointer.sourceSha256 ||
    original.importedRevision !== revision ||
    original.importedRecordCount !== 1 ||
    typeof original.decision !== "string" ||
    !["legacy-imported", "invalid-canonical-repaired", "legacy-update-finalized"].includes(
      original.decision,
    )
  ) {
    return undefined;
  }
  return { sourceSha256: pointer.sourceSha256, revision };
}

export function canFinalizeImportedUpdate(
  before: { payload: RestartSentinelPayload; revision: number },
  next: RestartSentinelPayload,
  canonicalImport: CanonicalImport | undefined,
): boolean {
  const pending = before.payload;
  return (
    canonicalImport?.revision === before.revision &&
    isPendingControlPlaneUpdateRestartSentinel(pending) &&
    !pending.stats?.runId &&
    Boolean(pending.stats?.handoffId) &&
    next.kind === "update" &&
    !next.stats?.runId &&
    !isPendingControlPlaneUpdateRestartSentinel(next) &&
    next.stats?.handoffId === pending.stats?.handoffId &&
    next.stats?.root === pending.stats?.root &&
    next.sessionKey === pending.sessionKey &&
    next.threadId === pending.threadId &&
    isDeepStrictEqual(next.deliveryContext, pending.deliveryContext)
  );
}
