import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: typeof CLAW_CRON_REF_SCHEMA_VERSION;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type CronRefRow = {
  schema_version: string;
  agent_id: string;
  manifest_id: string;
  declaration_key: string;
  scheduler_job_id: string | null;
  status: PersistedClawCronRef["status"];
  job_json: string;
  error: string | null;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export type ClawCronGateway = {
  add: (input: Record<string, unknown>) => Promise<unknown>;
  remove: (schedulerJobId: string) => Promise<unknown>;
};

export class ClawCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedClawCronRef[],
  ) {
    super(message);
    this.name = "ClawCronInstallError";
  }
}

function ensureCronRefTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claw_cron_refs (
      agent_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      declaration_key TEXT NOT NULL UNIQUE,
      scheduler_job_id TEXT UNIQUE,
      status TEXT NOT NULL,
      job_json TEXT NOT NULL,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (agent_id, manifest_id)
    );
  `);
}

function rowToRef(row: CronRefRow): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    status: row.status,
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function persistPendingRef(
  plan: ClawAddPlan,
  job: ClawCronJob,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const nowMs = options.nowMs ?? Date.now();
  const record: PersistedClawCronRef = {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    manifestId: job.id,
    declarationKey: `claw:${plan.agent.finalId}:${job.id}`,
    status: "pending",
    job,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureCronRefTable(db);
    db.prepare(
      `INSERT INTO claw_cron_refs (
         agent_id, manifest_id, schema_version, declaration_key, scheduler_job_id,
         status, job_json, error, created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @manifest_id, @schema_version, @declaration_key, NULL,
         @status, @job_json, NULL, @created_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      manifest_id: record.manifestId,
      schema_version: record.schemaVersion,
      declaration_key: record.declarationKey,
      status: record.status,
      job_json: JSON.stringify(record.job),
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }, options);
  return record;
}

function updateRef(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: "complete" | "failed"; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const updated = {
    ...ref,
    ...update,
    updatedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureCronRefTable(db);
    db.prepare(
      `UPDATE claw_cron_refs
          SET scheduler_job_id = @scheduler_job_id,
              status = @status,
              error = @error,
              updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id AND manifest_id = @manifest_id`,
    ).run({
      agent_id: ref.agentId,
      manifest_id: ref.manifestId,
      scheduler_job_id: update.schedulerJobId ?? null,
      status: update.status,
      error: update.error ?? null,
      updated_at_ms: updated.updatedAtMs,
    });
  }, options);
  return updated;
}

function schedulerJobFromResult(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return { id: record.id };
  }
  const job = record.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return { id: (job as Record<string, unknown>).id as string };
  }
  return undefined;
}

function gatewayInput(plan: ClawAddPlan, ref: PersistedClawCronRef): Record<string, unknown> {
  const job = ref.job;
  return {
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId: plan.agent.finalId },
    enabled: true,
    agentId: plan.agent.finalId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? "session:main" : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  };
}

export async function installClawCronJobs(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    gateway?: Pick<ClawCronGateway, "add">;
    nowMs?: number;
  } = {},
): Promise<PersistedClawCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new ClawCronInstallError(
      "cron_gateway_required",
      "Claw cron jobs require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
  for (const action of actions) {
    const details = action.details as (ClawCronJob & { agentId?: string }) | undefined;
    if (!details?.id) {
      throw new ClawCronInstallError(
        "cron_plan_invalid",
        `Cron action ${action.id} is invalid.`,
        refs,
      );
    }
    const job: ClawCronJob = {
      id: details.id,
      ...(details.name ? { name: details.name } : {}),
      schedule: details.schedule,
      session: details.session,
      message: details.message,
      ...(details.delivery ? { delivery: details.delivery } : {}),
    };
    const pending = persistPendingRef(plan, job, options);
    refs.push(pending);
    let result: { id: string } | undefined;
    try {
      result = schedulerJobFromResult(await options.gateway.add(gatewayInput(plan, pending)));
      if (!result) {
        throw new Error("cron.add returned no scheduler job id");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refs[refs.length - 1] = updateRef(pending, { status: "failed", error: message }, options);
      throw new ClawCronInstallError("cron_install_failed", message, refs);
    }
    try {
      refs[refs.length - 1] = updateRef(
        pending,
        { status: "complete", schedulerJobId: result.id },
        options,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ClawCronInstallError(
        "cron_provenance_failed",
        `cron.add succeeded, but its scheduler id could not be persisted: ${message}`,
        refs,
      );
    }
  }
  return refs;
}

export function readClawCronRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawCronRef[] {
  const database = openOpenClawStateDatabase(options);
  ensureCronRefTable(database.db);
  const rows = database.db
    .prepare(
      `SELECT schema_version, agent_id, manifest_id, declaration_key, scheduler_job_id,
              status, job_json, error, created_at_ms, updated_at_ms
         FROM claw_cron_refs
        WHERE agent_id = ?
        ORDER BY manifest_id`,
    )
    .all(agentId) as CronRefRow[];
  return rows.map(rowToRef);
}

export function deleteClawCronRef(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    ensureCronRefTable(db);
    db.prepare("DELETE FROM claw_cron_refs WHERE agent_id = ? AND manifest_id = ?").run(
      agentId,
      manifestId,
    );
  }, options);
}
