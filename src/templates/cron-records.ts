import type { Selectable } from "kysely";
import type { CronJobCreate } from "../cron/types.js";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { TemplateCronJob } from "./manifest-contract.js";

export const TEMPLATE_CRON_REF_SCHEMA_VERSION = "openclaw.templateCronRef.v1" as const;

export type PersistedTemplateCronRef = {
  schemaVersion: string;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: TemplateCronJob | { automation: CronJobCreate };
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type CronRefDatabase = Pick<DB, "template_cron_refs">;
type CronRefRow = Selectable<CronRefDatabase["template_cron_refs"]>;

function rowToTemplateCronRef(row: CronRefRow): PersistedTemplateCronRef {
  return {
    schemaVersion: row.schema_version,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    // SAFETY: Lifecycle writers own the existing persisted status enum.
    status: row.status as PersistedTemplateCronRef["status"],
    // SAFETY: Template cron writers persist validated manifest jobs as JSON.
    job: JSON.parse(row.job_json) as TemplateCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function readAllTemplateCronRefsInDatabase(
  db: EngineConnection,
): PersistedTemplateCronRef[] {
  if (!tableExists(db, "template_cron_refs")) {
    return [];
  }
  const query = getNodeSqliteKysely<CronRefDatabase>(db)
    .selectFrom("template_cron_refs")
    .selectAll()
    .orderBy("agent_id")
    .orderBy("manifest_id")
    .compile();
  const rows = db /* sqlite-allow-raw: read-only Template cron reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Template cron reference column.
    .all() as CronRefRow[];
  return rows.map(rowToTemplateCronRef);
}
