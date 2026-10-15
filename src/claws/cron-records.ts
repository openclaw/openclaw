import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ClawCronJob } from "./manifest-contract.js";

export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: string;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CronRefDatabase = Pick<DB, "claw_cron_refs">;
export type CronRefRow = Selectable<CronRefDatabase["claw_cron_refs"]>;

export function rowToClawCronRef(row: CronRefRow): PersistedClawCronRef {
  return {
    schemaVersion: row.schema_version,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    // SAFETY: Lifecycle writers own the existing persisted status enum.
    status: row.status as PersistedClawCronRef["status"],
    // SAFETY: Claw cron writers persist validated manifest jobs as JSON.
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function clawCronRefToRow(ref: PersistedClawCronRef): CronRefRow {
  return {
    schema_version: ref.schemaVersion,
    agent_id: ref.agentId,
    manifest_id: ref.manifestId,
    declaration_key: ref.declarationKey,
    scheduler_job_id: ref.schedulerJobId ?? null,
    status: ref.status,
    job_json: JSON.stringify(ref.job),
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}

export function readAllClawCronRefsInDatabase(db: EngineConnection): PersistedClawCronRef[] {
  if (
    !db /* sqlite-allow-raw: read-only Claw cron table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_cron_refs'")
      .get()
  ) {
    return [];
  }
  const query = getNodeSqliteKysely<CronRefDatabase>(db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .orderBy("agent_id")
    .orderBy("manifest_id")
    .compile();
  const rows = db /* sqlite-allow-raw: read-only Claw cron reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Claw cron reference column.
    .all() as CronRefRow[];
  return rows.map(rowToClawCronRef);
}
