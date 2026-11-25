/** Downgrade-stable persistence for runtime-private cron authority. */
import { createHash } from "node:crypto";
import { safeParseJson } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { normalizeCronRuntimeAuthority } from "../runtime-authority.js";
import { normalizeCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "../types.js";

export const CRON_RUNTIME_AUTHORITY_TABLE = "cron_job_runtime_authorities";
const CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION = 1;

type CronAuthorityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "cron_job_runtime_authorities" | "cron_jobs"
>;
type CronRuntimeAuthorityRow = Selectable<
  OpenClawStateKyselyDatabase["cron_job_runtime_authorities"]
>;

type CronRuntimeAuthorityLoadResult = {
  repairJobIds: string[];
};

export function getCronAuthorityKysely(db: EngineConnection) {
  return getNodeSqliteKysely<CronAuthorityDatabase>(db);
}

function normalizedToolsAllow(job: CronStoredJob): string[] | null {
  const toolsAllow = job.payload.toolsAllow;
  return toolsAllow === undefined ? null : [...toolsAllow].toSorted();
}

function normalizedToolsAllowProvenance(
  value: CronToolsAllowProvenance | undefined,
): CronToolsAllowProvenance | null {
  return value?.version === 1 && value.source === "final-executable-surface"
    ? { version: 1, source: "final-executable-surface" }
    : null;
}

/** Binds authority to only the canonical inputs that can change its authorization meaning. */
export function cronRuntimeAuthorityInputFingerprint(job: CronStoredJob): string {
  const scheduledToolPolicy = normalizeCronScheduledToolPolicy(job.scheduledToolPolicy) ?? null;
  const canonical = {
    version: CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION,
    usesToolRuntime: cronJobUsesToolRuntime(job),
    toolsAllow: normalizedToolsAllow(job),
    toolsAllowIsDefault: job.payload.toolsAllowIsDefault === true,
    scheduledToolPolicy,
    toolsAllowProvenance: normalizedToolsAllowProvenance(job.toolsAllowProvenance),
  };
  return `v${CRON_RUNTIME_AUTHORITY_FINGERPRINT_VERSION}:${createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")}`;
}

export function loadCronRuntimeAuthorityRows(
  db: EngineConnection,
  storeKey: string,
  jobIds: Iterable<string>,
): CronRuntimeAuthorityRow[] {
  if (!tableExists(db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getCronAuthorityKysely(db)
      .selectFrom("cron_job_runtime_authorities")
      .selectAll()
      .where("store_key", "=", storeKey)
      .where("job_id", "in", sqliteStringSet([...jobIds])),
  ).rows;
}

export function applyCronRuntimeAuthorityRow(
  job: CronStoredJob,
  row: CronRuntimeAuthorityRow,
): "ok" | "repair" {
  delete job.runtimeAuthority;
  delete job.runtimeAuthorityRecoveryRequired;
  if (row.recovery_required === 1) {
    job.runtimeAuthorityRecoveryRequired = true;
    return "ok";
  }
  const authority = normalizeCronRuntimeAuthority(safeParseJson(row.authority_json ?? ""));
  if (!authority || row.authority_input_fingerprint !== cronRuntimeAuthorityInputFingerprint(job)) {
    job.runtimeAuthorityRecoveryRequired = true;
    return "repair";
  }
  job.runtimeAuthority = authority;
  return "ok";
}

/** Applies stored authority only when its authorization inputs still match exactly. */
export function loadCronRuntimeAuthorities(params: {
  db: EngineConnection;
  storeKey: string;
  jobs: CronStoredJob[];
}): CronRuntimeAuthorityLoadResult {
  const jobsById = new Map(params.jobs.map((job) => [job.id, job] as const));
  const repairJobIds: string[] = [];
  for (const row of loadCronRuntimeAuthorityRows(params.db, params.storeKey, jobsById.keys())) {
    const job = jobsById.get(row.job_id);
    if (!job) {
      continue;
    }
    if (applyCronRuntimeAuthorityRow(job, row) === "repair") {
      repairJobIds.push(job.id);
    }
  }
  return { repairJobIds };
}

export function writeRecoveryRow(db: EngineConnection, storeKey: string, jobId: string): void {
  executeSqliteQuerySync(
    db,
    getCronAuthorityKysely(db)
      .insertInto("cron_job_runtime_authorities")
      .values({
        store_key: storeKey,
        job_id: jobId,
        authority_json: null,
        authority_input_fingerprint: null,
        recovery_required: 1,
      })
      .onConflict((conflict) =>
        conflict.columns(["store_key", "job_id"]).doUpdateSet({
          authority_json: null,
          authority_input_fingerprint: null,
          recovery_required: 1,
        }),
      ),
  );
}

/** Revalidates downgrade-detected drift before retiring stale authority durably. */
export function repairCronRuntimeAuthorityRows(params: {
  db: EngineConnection;
  storeKey: string;
  jobs: CronStoredJob[];
  jobIds: readonly string[];
}): boolean {
  if (!tableExists(params.db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return false;
  }
  const requested = new Set(params.jobIds);
  const jobsById = new Map(params.jobs.map((job) => [job.id, job] as const));
  let repaired = false;
  for (const row of loadCronRuntimeAuthorityRows(params.db, params.storeKey, requested)) {
    if (!requested.has(row.job_id)) {
      continue;
    }
    const job = jobsById.get(row.job_id);
    if (!job) {
      continue;
    }
    if (applyCronRuntimeAuthorityRow(job, row) === "repair") {
      writeRecoveryRow(params.db, params.storeKey, job.id);
      repaired = true;
    }
  }
  return repaired;
}
