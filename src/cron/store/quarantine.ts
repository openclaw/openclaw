/** Durable malformed-cron recovery records stored in the shared SQLite database. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSqliteAuditRecordStore } from "../../infra/sqlite-audit-record-store.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import { cronStoreKey } from "./key.js";

type CronQuarantineDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

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
  ).rows.map((row) => JSON.parse(row.payload_json) as CronQuarantinedJob);
}

/** Reads quarantined cron rows without creating or migrating a state database. */
export async function loadCronQuarantinedJobs(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CronQuarantinedJob[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "cron.quarantine", storeKey: cronStoreKey(storePath) },
  );
  if (reply && (!reply.ok || reply.type !== "cron.quarantine")) {
    throw new Error("Unexpected cron quarantine observation result");
  }
  return reply?.entries ?? [];
}

/** Writes recovery records into the caller-owned SQLite transaction when provided. */
export function saveCronQuarantinedJobs(params: {
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
  nowMs: number;
  database?: OpenClawStateDatabase;
}): void {
  if (params.entries.length === 0) {
    return;
  }

  // Quarantine contains recoverable operator jobs, not disposable audit history.
  const store = createSqliteAuditRecordStore<CronQuarantinedJob>({
    scope: cronQuarantineScope(params.storePath),
    maxEntries: Number.MAX_SAFE_INTEGER,
    ...(params.database ? { database: params.database } : {}),
  });

  const records = params.entries.map((entry) => {
    const quarantinedAtMs = "quarantinedAtMs" in entry ? entry.quarantinedAtMs : params.nowMs;
    return {
      key: cronQuarantineEntryKey(entry),
      value: { ...entry, quarantinedAtMs },
      createdAt: quarantinedAtMs,
    };
  });

  store.registerLegacyMany(records);
}
