import type { SQLInputValue } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronRefToRow,
  rowToClawCronRef,
  type CronRefDatabase,
  type CronRefRow,
  type PersistedClawCronRef,
} from "./cron-records.js";
import { ClawCronInstallError } from "./cron.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export function persistClawCronPendingRef(
  plan: ClawAddPlan,
  job: ClawCronJob,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const nowMs = options.nowMs ?? Date.now();
  const declarationKey = `claw:${plan.agent.finalId}:${job.id}`;
  const database = openOpenClawStateDatabase(options);
  const query = getNodeSqliteKysely<CronRefDatabase>(database.db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .where("agent_id", "=", plan.agent.finalId)
    .where("manifest_id", "=", job.id)
    .compile();
  const existing =
    database.db /* sqlite-allow-raw: execute compiled Kysely with the existing native read error boundary. */
      .prepare(query.sql)
      // SAFETY: Compiled predicates bind strings; the canonical schema supplies the row shape.
      .get(...(query.parameters as SQLInputValue[])) as CronRefRow | undefined;
  if (existing) {
    const ref = rowToClawCronRef(existing);
    if (ref.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION) {
      throw new ClawCronInstallError(
        "cron_provenance_conflict",
        `Cron declaration ${JSON.stringify(job.id)} has an unsupported provenance version.`,
        [ref],
      );
    }
    if (ref.declarationKey !== declarationKey || JSON.stringify(ref.job) !== JSON.stringify(job)) {
      throw new ClawCronInstallError(
        "cron_provenance_conflict",
        `Cron declaration ${JSON.stringify(job.id)} differs from its pending ownership record.`,
        [ref],
      );
    }
    if (ref.status === "complete") {
      return ref;
    }
    return updateClawCronRef(ref, { status: "pending" }, options);
  }
  const record: PersistedClawCronRef = {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    manifestId: job.id,
    declarationKey,
    status: "pending",
    job,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .insertInto("claw_cron_refs")
        .values(clawCronRefToRow(record)),
    );
  }, options);
  return record;
}

export function updateClawCronRef(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: PersistedClawCronRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  // Omitted fields are cleared in SQLite and must not survive in the returned result.
  const { schedulerJobId: _schedulerJobId, error: _error, ...retained } = ref;
  const updated = {
    ...retained,
    ...update,
    updatedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .updateTable("claw_cron_refs")
        .set({
          scheduler_job_id: updated.schedulerJobId ?? null,
          status: updated.status,
          error: updated.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("manifest_id", "=", ref.manifestId),
    );
  }, options);
  return updated;
}
