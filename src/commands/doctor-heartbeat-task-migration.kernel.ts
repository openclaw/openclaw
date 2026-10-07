/** Shared task conversion for Doctor and admitted portable-artifact imports. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordConvertedProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.kernel.js";
import type { CronJobScratchState } from "../cron/scratch-contract.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  assertCronStoreCanPersist,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "../cron/store/runtime-authority-store.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronStoredJob as CronJob } from "../cron/types.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  heartbeatTaskDeclarationKey,
  isHeartbeatTaskCronJob,
} from "./doctor-heartbeat-task-identity.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

type ValidatedHeartbeatTask = {
  task: LegacyHeartbeatTask;
  intervalMs: number;
  occurrenceIndex: number;
};

export function validateHeartbeatTasks(
  tasks: readonly LegacyHeartbeatTask[],
  declaredEntryCount: number,
): ValidatedHeartbeatTask[] {
  if (tasks.length === 0) {
    throw new Error("tasks: block has no complete name/interval/prompt entries");
  }
  if (tasks.length !== declaredEntryCount) {
    throw new Error("tasks: block contains an incomplete name/interval/prompt entry");
  }
  const occurrenceCounts = new Map<string, number>();
  const validated: ValidatedHeartbeatTask[] = [];
  for (const task of tasks) {
    const intervalMs = parseDurationMs(task.interval, { defaultUnit: "m" });
    if (intervalMs <= 0) {
      throw new Error(`task ${JSON.stringify(task.name)} interval must be greater than zero`);
    }
    const occurrenceIndex = occurrenceCounts.get(task.name) ?? 0;
    occurrenceCounts.set(task.name, occurrenceIndex + 1);
    validated.push({ task, intervalMs, occurrenceIndex });
  }
  return validated;
}

type TaskJobInput = {
  agentId: string;
  task: LegacyHeartbeatTask;
  intervalMs: number;
  lastRunAtMs?: number;
  existing?: CronJob;
  nowMs: number;
  monitor: CronJob;
};

function taskPayload(monitor: CronJob, message: string) {
  if (monitor.payload.kind !== "agentTurn") {
    throw new Error(`Automation ${monitor.id} has not completed heartbeat conversion`);
  }
  const { skipIfScratchEmpty: _skipIfScratchEmpty, ...payload } = monitor.payload;
  return { ...payload, message };
}

function taskJobInput(params: TaskJobInput) {
  const nextDueMs =
    params.lastRunAtMs === undefined || params.lastRunAtMs + params.intervalMs <= params.nowMs
      ? params.nowMs + 1
      : params.lastRunAtMs + params.intervalMs;
  return {
    displayName: truncateUtf16Safe(`Heartbeat task: ${params.task.name}`, 200),
    name: params.task.name,
    description: "Migrated from heartbeat monitor scratch by openclaw doctor.",
    agentId: params.agentId,
    enabled: params.monitor.enabled,
    schedule: {
      kind: "every" as const,
      everyMs: params.intervalMs,
      anchorMs: nextDueMs,
    },
    payload: taskPayload(params.monitor, params.task.prompt),
    sessionTarget: params.monitor.sessionTarget,
    sessionKey: params.monitor.sessionKey,
    activeHours: params.monitor.activeHours,
    idleOnly: params.monitor.idleOnly,
    delivery: params.monitor.delivery,
    wakeMode: "now" as const,
    ...(params.lastRunAtMs === undefined ? {} : { state: { lastRunAtMs: params.lastRunAtMs } }),
  };
}

type TaskJobPlan = {
  declarationKey: string;
  previous?: CronJob;
  job: CronJob;
  sortOrder: number;
};

export type AgentTaskMigrationPlan = {
  monitor: CronJob;
  scratchRevision: number;
  sourceSha256?: string;
  strippedContent: string;
  jobs: TaskJobPlan[];
};

export type CronPlanningSnapshot = {
  jobs: CronJob[];
  sortOrderByJobId: Map<string, number>;
  nextSortOrder: number;
};

export type MigrationCommitResult =
  | { ok: true; currentRevision: number }
  | { ok: false; reason: "job-conflict" | "revision-conflict" };

function convergeTaskJob(params: TaskJobInput): CronJob {
  if (params.existing) {
    return convertStoredHeartbeatTask(params.existing, params.monitor, params.nowMs);
  }
  const { state, ...fields } = taskJobInput(params);
  const job: CronJob = {
    id: randomUUID(),
    ...fields,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    state: { ...state },
  };
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
  return job;
}

export function convertStoredHeartbeatTask(
  previous: CronJob,
  monitor: CronJob,
  nowMs: number,
): CronJob {
  if (!isHeartbeatTaskCronJob(previous)) {
    throw new Error(`Job ${previous.id} is not a legacy task`);
  }
  const { text, kind: _kind, ...toolPolicy } = previous.payload;
  const job: CronJob = {
    ...structuredClone(previous),
    payload: { ...taskPayload(monitor, text), ...toolPolicy },
    enabled: previous.enabled && monitor.enabled,
    sessionTarget: monitor.sessionTarget,
    sessionKey: monitor.sessionKey,
    activeHours: monitor.activeHours,
    idleOnly: monitor.idleOnly,
    delivery: previous.delivery ?? monitor.delivery,
    wakeMode: "now",
    updatedAtMs: nowMs,
  };
  delete job.declarationKey;
  return job;
}

export function planHeartbeatTaskMigration(params: {
  snapshot: CronPlanningSnapshot;
  agentId: string;
  jobId: string;
  scratch: NonNullable<CronJobScratchState["scratch"]>;
  legacyTaskState?: Record<string, number>;
  nowMs: number;
}): AgentTaskMigrationPlan {
  const { snapshot, agentId, scratch, nowMs } = params;
  const monitor = snapshot.jobs.find((job) => job.id === params.jobId);
  if (!monitor || monitor.agentId !== agentId) {
    throw new Error(
      `Agent "${agentId}" automation changed during task planning; scratch was left unchanged.`,
    );
  }
  const document = analyzeLegacyHeartbeatTasks(scratch.content);
  const tasks = validateHeartbeatTasks(document.tasks, document.taskEntryCount);
  const jobs: TaskJobPlan[] = [];
  for (const { task, intervalMs, occurrenceIndex } of tasks) {
    const declarationKey = heartbeatTaskDeclarationKey(agentId, task.name, occurrenceIndex);
    const matches = snapshot.jobs.filter((job) => job.declarationKey === declarationKey);
    const existing = matches[0];
    if (
      matches.length > 1 ||
      (existing &&
        (!isHeartbeatTaskCronJob(existing) ||
          existing.agentId !== agentId ||
          existing.name !== task.name))
    ) {
      throw new Error(
        `Agent "${agentId}" task ${JSON.stringify(task.name)} collides with an incompatible cron declaration; scratch was left unchanged.`,
      );
    }
    const legacyLastRun = params.legacyTaskState?.[task.name];
    const lastRunAtMs =
      typeof legacyLastRun === "number" && Number.isFinite(legacyLastRun)
        ? legacyLastRun
        : undefined;
    const job = convergeTaskJob({
      agentId,
      task,
      intervalMs,
      lastRunAtMs,
      existing,
      nowMs,
      monitor,
    });
    jobs.push({
      declarationKey,
      ...(existing ? { previous: structuredClone(existing) } : {}),
      job,
      sortOrder: reserveSortOrder(snapshot, existing),
    });
  }
  assertCronStoreCanPersist({ version: 1, jobs: jobs.map((plan) => plan.job) });
  return {
    monitor,
    scratchRevision: scratch.revision,
    ...(scratch.sourceSha256 ? { sourceSha256: scratch.sourceSha256 } : {}),
    strippedContent: document.strippedContent,
    jobs,
  };
}

export function loadHeartbeatTaskPlanningSnapshot(
  db: DatabaseSync,
  storePath: string,
): CronPlanningSnapshot {
  const rows = loadCronRows(db, cronStoreKey(storePath));
  const sortOrderByJobId = new Map(rows.map((row) => [row.job_id, row.sort_order] as const));
  return {
    jobs: loadedCronStoreFromRows(rows).store.jobs,
    sortOrderByJobId,
    nextSortOrder: rows.reduce((max, row) => Math.max(max, row.sort_order + 1), 0),
  };
}

function reserveSortOrder(snapshot: CronPlanningSnapshot, existing?: CronJob): number {
  const persisted = existing ? snapshot.sortOrderByJobId.get(existing.id) : undefined;
  if (persisted !== undefined) {
    return persisted;
  }
  const sortOrder = snapshot.nextSortOrder;
  snapshot.nextSortOrder += 1;
  return sortOrder;
}

function readScratchRevision(db: DatabaseSync, storeKey: string, jobId: string): number {
  return (
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .selectFrom("cron_job_scratch")
        .select("revision")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId),
    ).rows[0]?.revision ?? 0
  );
}

export function commitHeartbeatTaskMigrationInDatabase(params: {
  db: DatabaseSync;
  storePath: string;
  nowMs: number;
  plan: AgentTaskMigrationPlan;
}): MigrationCommitResult {
  const storeKey = cronStoreKey(params.storePath);
  const { db } = params;
  if (readScratchRevision(db, storeKey, params.plan.monitor.id) !== params.plan.scratchRevision) {
    return { ok: false, reason: "revision-conflict" } as const;
  }

  const rows = loadCronRows(db, storeKey);
  const jobsById = new Map(
    loadedCronStoreFromRows(rows).store.jobs.map((job) => [job.id, job] as const),
  );
  const monitor = jobsById.get(params.plan.monitor.id);
  const receipt = monitor?.agentId
    ? readDefaultProactiveJobReceiptInDatabase(db, params.storePath, monitor.agentId)
    : undefined;
  if (
    !monitor?.agentId ||
    receipt?.phase !== "pending" ||
    receipt.jobId !== monitor.id ||
    !isDeepStrictEqual(monitor, params.plan.monitor) ||
    monitor.state.runningAtMs !== undefined
  ) {
    return { ok: false, reason: "job-conflict" } as const;
  }
  for (const jobPlan of params.plan.jobs) {
    const matchingRows = rows.filter((row) => row.declaration_key === jobPlan.declarationKey);
    if (jobPlan.previous) {
      const current = jobsById.get(jobPlan.previous.id);
      if (
        matchingRows.length !== 1 ||
        !current ||
        current.state.runningAtMs !== undefined ||
        !isDeepStrictEqual(current, jobPlan.previous)
      ) {
        return { ok: false, reason: "job-conflict" } as const;
      }
    } else if (matchingRows.length > 0 || rows.some((row) => row.job_id === jobPlan.job.id)) {
      return { ok: false, reason: "job-conflict" } as const;
    }
  }

  loadCronRuntimeAuthorities({ db, storeKey, jobs: [...jobsById.values()] });
  for (const jobPlan of params.plan.jobs) {
    const current = jobsById.get(jobPlan.job.id);
    jobPlan.job.runtimeAuthority = current?.runtimeAuthority;
    jobPlan.job.runtimeAuthorityRecoveryRequired = current?.runtimeAuthorityRecoveryRequired;
    if (!jobPlan.previous || !isDeepStrictEqual(jobPlan.previous, jobPlan.job)) {
      upsertCronJobRow(db, storeKey, jobPlan.job, jobPlan.sortOrder, {
        preserveRuntimeState: true,
      });
      replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [jobPlan.job] });
    }
  }

  for (const { job } of params.plan.jobs) {
    recordConvertedProactiveJobInDatabase(db, params.storePath, monitor.agentId, job.id);
  }

  const updated = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .updateTable("cron_job_scratch")
      .set({
        content: params.plan.strippedContent,
        revision: params.plan.scratchRevision + 1,
        source_sha256: params.plan.sourceSha256 ?? null,
        updated_at_ms: params.nowMs,
      })
      .where("store_key", "=", storeKey)
      .where("job_id", "=", params.plan.monitor.id)
      .where("revision", "=", params.plan.scratchRevision),
  );
  if (updated.numAffectedRows !== 1n) {
    throw new Error("scratch revision changed inside task migration transaction");
  }
  // The scheduler reloads these durable due times and owns timer arming.
  return { ok: true, currentRevision: params.plan.scratchRevision + 1 } as const;
}
