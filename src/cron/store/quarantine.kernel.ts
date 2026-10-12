import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
  type PreparedSqliteAuditRecord,
} from "../../infra/sqlite-audit-record.kernel.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import { cronStoreKey } from "./key.js";

type CronQuarantineDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

export type CronQuarantineRegistration = {
  storeKey: string;
  records: PreparedSqliteAuditRecord[];
};

function cronQuarantineScope(storePath: string): string {
  return `cron.quarantine:${cronStoreKey(storePath)}`;
}

function cronQuarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const identity = JSON.stringify({
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function prepareCronQuarantineRegistration(params: {
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
  nowMs: number;
}): CronQuarantineRegistration {
  const storeKey = cronStoreKey(params.storePath);
  const scope = cronQuarantineScope(storeKey);
  const records = params.entries.map((entry) => {
    const quarantinedAtMs = "quarantinedAtMs" in entry ? entry.quarantinedAtMs : params.nowMs;
    return prepareSqliteAuditRecord(scope, {
      key: cronQuarantineEntryKey(entry),
      value: { ...entry, quarantinedAtMs },
      createdAt: quarantinedAtMs,
    });
  });
  return { storeKey, records };
}

/** The caller owns the complete synchronous transaction, including other Cron changes. */
export function registerCronQuarantineInDatabase(
  database: DatabaseSync,
  input: CronQuarantineRegistration,
): void {
  if (input.records.length === 0) {
    return;
  }
  createSqliteAuditRecordKernel<CronQuarantinedJob>(database, {
    scope: cronQuarantineScope(input.storeKey),
    // Quarantine contains recoverable operator jobs, not disposable audit history.
    maxEntries: Number.MAX_SAFE_INTEGER,
  }).registerLegacyMany(input.records);
}

/** Deletes quarantine rows inside the caller-owned SQLite transaction. */
export function deleteCronQuarantinedJobsFromDatabase(params: {
  database: DatabaseSync;
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
}): void {
  if (params.entries.length === 0) {
    return;
  }
  const scope = cronQuarantineScope(params.storePath);
  for (const entry of params.entries) {
    executeSqliteQuerySync(
      params.database,
      getNodeSqliteKysely<CronQuarantineDatabase>(params.database)
        .deleteFrom("diagnostic_events")
        .where("scope", "=", scope)
        .where("event_key", "=", cronQuarantineEntryKey(entry)),
    );
  }
}

export function readCronQuarantinedJobsInDatabase(
  database: DatabaseSync,
  storeKey: string,
): CronQuarantinedJob[] {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<CronQuarantineDatabase>(database)
      .selectFrom("diagnostic_events")
      .select("payload_json")
      .where("scope", "=", cronQuarantineScope(storeKey))
      .orderBy("sequence", "asc"),
  ).rows.map((row) => {
    // SAFETY: This scope stores CronQuarantinedJob payloads serialized by the quarantine owner.
    return JSON.parse(row.payload_json) as CronQuarantinedJob;
  });
}
