/** Doctor-owned migration from heartbeat scratch `tasks:` blocks into cron jobs. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordConvertedProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  assertCronStoreCanPersist,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
  projectCronJobThroughStorageCodec,
} from "../cron/store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "../cron/store/runtime-authority-store.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronStoredJob as CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { shortenHomePath } from "../utils.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { resolveHeartbeatConfig } from "./doctor-heartbeat-legacy.js";
import { resolveHeartbeatSession } from "./doctor-heartbeat-session.js";
import {
  heartbeatTaskDeclarationKey,
  isHeartbeatTaskCronJob,
} from "./doctor-heartbeat-task-identity.js";
import { readLegacyHeartbeatScratch } from "./doctor-heartbeat-task-scratch.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

type HeartbeatTaskMigrationResult = { changes: string[]; warnings: string[] };

function resolveHeartbeatTaskMigrationAgents(cfg: OpenClawConfig) {
  return listAgentIds(cfg).map((agentId) => ({
    agentId,
    heartbeat: resolveHeartbeatConfig(cfg, agentId),
  }));
}

type ValidatedHeartbeatTask = {
  task: LegacyHeartbeatTask;
  intervalMs: number;
  occurrenceIndex: number;
};

function validateTasks(
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

/** Reports task blocks still owned by heartbeat scratch without changing them. */
export async function collectHeartbeatTaskMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const MIGRATION_FINDING_DEFAULTS = {
    checkId: "core/doctor/heartbeat-task-cron-migration",
    severity: "warning",
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to convert heartbeat tasks into automations.`,
  } as const;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const findings: HealthFinding[] = [];
  for (const agent of resolveHeartbeatTaskMigrationAgents(cfg)) {
    let monitor: ReturnType<typeof readLegacyHeartbeatScratch>;
    try {
      monitor = readLegacyHeartbeatScratch(storePath, agent.agentId, { env });
    } catch (error) {
      findings.push({
        ...MIGRATION_FINDING_DEFAULTS,
        path: storePath,
        target: agent.agentId,
        requirement: "heartbeat-task-migration-blocked",
        severity: "error",
        message: `Agent "${agent.agentId}" heartbeat scratch cannot be inspected: ${errorMessage(error)}`,
      });
      continue;
    }
    const content = monitor?.state.scratch?.content;
    if (!content) {
      continue;
    }
    const document = analyzeLegacyHeartbeatTasks(content);
    if (!document.hasTasksBlock) {
      continue;
    }
    try {
      validateTasks(document.tasks, document.taskEntryCount);
      findings.push({
        ...MIGRATION_FINDING_DEFAULTS,
        path: storePath,
        target: agent.agentId,
        requirement: "heartbeat-tasks-in-scratch",
        message: `Agent "${agent.agentId}" has ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} that must become cron jobs.`,
      });
    } catch (error) {
      findings.push({
        ...MIGRATION_FINDING_DEFAULTS,
        path: storePath,
        target: agent.agentId,
        requirement: "heartbeat-task-migration-blocked",
        severity: "error",
        message: `Agent "${agent.agentId}" heartbeat tasks cannot be migrated: ${errorMessage(error)}`,
      });
    }
  }
  return findings;
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

type AgentTaskMigrationPlan = {
  monitor: CronJob;
  scratchRevision: number;
  sourceSha256?: string;
  strippedContent: string;
  jobs: TaskJobPlan[];
};

type CronPlanningSnapshot = {
  jobs: CronJob[];
  sortOrderByJobId: Map<string, number>;
  nextSortOrder: number;
};

type MigrationCommitResult =
  | { ok: true; currentRevision: number }
  | { ok: false; reason: "job-conflict" | "revision-conflict" };

function convergeTaskJob(params: TaskJobInput): CronJob {
  if (params.existing) {
    return convertStoredTask(params.existing, params.monitor, params.nowMs);
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

function convertStoredTask(previous: CronJob, monitor: CronJob, nowMs: number): CronJob {
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

/** Converts rows from earlier Doctors even when their source scratch block is already gone. */
export async function migrateStoredHeartbeatTaskJobs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const monitors = await ensureHeartbeatMonitorJobs(cfg, storePath, env);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, cronStoreKey(storePath));
      const jobs = loadedCronStoreFromRows(rows).store.jobs;
      loadCronRuntimeAuthorities({ db, storeKey: cronStoreKey(storePath), jobs });
      let converted = 0;
      for (const job of jobs) {
        if (!isHeartbeatTaskCronJob(job)) {
          continue;
        }
        const plannedMonitor = job.agentId ? monitors.get(job.agentId) : undefined;
        const monitor = plannedMonitor
          ? jobs.find((candidate) => candidate.id === plannedMonitor.id)
          : undefined;
        if (
          plannedMonitor &&
          (!monitor ||
            !isDeepStrictEqual(
              projectCronJobThroughStorageCodec(monitor),
              projectCronJobThroughStorageCodec(plannedMonitor),
            ))
        ) {
          throw new Error(
            `Monitor policy for task ${job.id} changed during planning; rerun Doctor.`,
          );
        }
        if (!monitor?.agentId) {
          throw new Error(
            `Legacy task ${job.id} has no unambiguous monitor owner; preserve its input and resolve the owner before rerunning Doctor.`,
          );
        }
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, monitor.agentId);
        if (receipt?.phase !== "pending" || receipt.jobId !== monitor.id) {
          throw new Error(`Heartbeat task ${job.id} no longer has a pending cutover owner`);
        }
        if (job.state.runningAtMs !== undefined) {
          throw new Error(
            `Legacy task ${job.id} is running; stop the Gateway before Doctor cutover.`,
          );
        }
        const convertedJob = convertStoredTask(job, monitor, Date.now());
        upsertCronJobRow(
          db,
          cronStoreKey(storePath),
          convertedJob,
          rows.find((row) => row.job_id === job.id)!.sort_order,
          { preserveRuntimeState: true },
        );
        replaceCronRuntimeAuthorityRows({
          db,
          storeKey: cronStoreKey(storePath),
          jobs: [convertedJob],
        });
        recordConvertedProactiveJobInDatabase(db, storePath, monitor.agentId, convertedJob.id);
        converted += 1;
      }
      return converted;
    },
    { env },
    { operationLabel: "doctor.heartbeat-task-retirement" },
  );
}

async function loadCronPlanningSnapshot(
  storePath: string,
  env: NodeJS.ProcessEnv,
): Promise<CronPlanningSnapshot> {
  const rows = loadCronRows(openOpenClawStateDatabase({ env }).db, cronStoreKey(storePath));
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

function commitAgentTaskMigration(params: {
  storePath: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  plan: AgentTaskMigrationPlan;
}): MigrationCommitResult {
  const storeKey = cronStoreKey(params.storePath);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (
        readScratchRevision(db, storeKey, params.plan.monitor.id) !== params.plan.scratchRevision
      ) {
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
      // Like cadence materialization, doctor only commits durable rows. A live
      // gateway reloads the cron store through its normal reload path and arms
      // these persisted nextRunAtMs values; doctor never owns its timer.
      return { ok: true, currentRevision: params.plan.scratchRevision + 1 } as const;
    },
    { env: params.env },
    { operationLabel: "doctor.heartbeat-task-migration" },
  );
}

async function clearLegacyTaskTimestamps(params: {
  storePath: string;
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  tasks: readonly LegacyHeartbeatTask[];
  expectedSessionId?: string;
  expectedState: Record<string, number>;
}): Promise<void> {
  await patchSessionEntryCore(
    { storePath: params.storePath, sessionKey: params.sessionKey, env: params.env },
    (entry) => {
      if (entry.sessionId !== params.expectedSessionId) {
        return null;
      }
      const remaining = { ...entry.heartbeatTaskState };
      let changed = false;
      for (const task of params.tasks) {
        if (
          Object.hasOwn(remaining, task.name) &&
          remaining[task.name] === params.expectedState[task.name]
        ) {
          delete remaining[task.name];
          changed = true;
        }
      }
      if (!changed) {
        return null;
      }
      return {
        heartbeatTaskState: Object.keys(remaining).length > 0 ? remaining : undefined,
      };
    },
    { preserveActivity: true },
  );
}

/** Converts valid scratch tasks and removes their source block in one SQLite transaction. */
export async function maybeMigrateHeartbeatTasksToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<HeartbeatTaskMigrationResult> {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  const candidates: Array<{
    agent: ReturnType<typeof resolveHeartbeatTaskMigrationAgents>[number];
    document: ReturnType<typeof analyzeLegacyHeartbeatTasks>;
    monitor: NonNullable<ReturnType<typeof readLegacyHeartbeatScratch>>;
    scratchRevision: number;
    validatedTasks: ValidatedHeartbeatTask[];
  }> = [];
  for (const agent of resolveHeartbeatTaskMigrationAgents(params.cfg)) {
    let monitor: ReturnType<typeof readLegacyHeartbeatScratch>;
    try {
      monitor = readLegacyHeartbeatScratch(storePath, agent.agentId, { env });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" heartbeat scratch could not be inspected: ${errorMessage(error)}.`,
      );
      continue;
    }
    const scratch = monitor?.state.scratch;
    if (!monitor || !scratch) {
      continue;
    }
    const document = analyzeLegacyHeartbeatTasks(scratch.content);
    if (!document.hasTasksBlock) {
      continue;
    }
    const tasks = document.tasks;
    let validatedTasks: ValidatedHeartbeatTask[];
    try {
      validatedTasks = validateTasks(tasks, document.taskEntryCount);
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" heartbeat tasks were not migrated: ${errorMessage(error)}.`,
      );
      continue;
    }
    if (!params.shouldRepair) {
      note(
        `${tasks.length} task${tasks.length === 1 ? "" : "s"} in ${shortenHomePath(storePath)} will become independently scheduled cron jobs for agent "${agent.agentId}".`,
        "Heartbeat task migration preview",
      );
      continue;
    }
    candidates.push({
      agent,
      document,
      monitor,
      scratchRevision: scratch.revision,
      validatedTasks,
    });
  }

  if (!params.shouldRepair || candidates.length === 0) {
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let snapshot: CronPlanningSnapshot;
  try {
    // The scratch revisions above are pinned before this async planning read.
    // Concurrent doctors can therefore plan R together and serialize at commit.
    snapshot = await loadCronPlanningSnapshot(storePath, env);
  } catch (error) {
    const warning = `Could not inspect cron jobs for heartbeat task migration: ${errorMessage(error)}`;
    note(warning, "Doctor warnings");
    return { changes, warnings: [...warnings, warning] };
  }

  for (const candidate of candidates) {
    const { agent, document, monitor, scratchRevision, validatedTasks } = candidate;
    const session = resolveHeartbeatSession(
      params.cfg,
      agent.agentId,
      agent.heartbeat,
      undefined,
      env,
    );
    const plannedMonitor = snapshot.jobs.find((job) => job.id === monitor.jobId);
    if (!plannedMonitor || plannedMonitor.agentId !== agent.agentId) {
      warnings.push(
        `Agent "${agent.agentId}" automation changed during task planning; scratch was left unchanged.`,
      );
      continue;
    }
    const legacyState = session.entry?.heartbeatTaskState ?? {};
    const jobPlans: TaskJobPlan[] = [];
    let blocked = false;
    for (const { task, intervalMs, occurrenceIndex } of validatedTasks) {
      const declarationKey = heartbeatTaskDeclarationKey(agent.agentId, task.name, occurrenceIndex);
      const matches = snapshot.jobs.filter((job) => job.declarationKey === declarationKey);
      const existing = matches[0];
      if (
        matches.length > 1 ||
        (existing &&
          (!isHeartbeatTaskCronJob(existing) ||
            existing.agentId !== agent.agentId ||
            existing.name !== task.name))
      ) {
        warnings.push(
          `Agent "${agent.agentId}" task ${JSON.stringify(task.name)} collides with an incompatible cron declaration; scratch was left unchanged.`,
        );
        blocked = true;
        break;
      }
      const legacyLastRun = legacyState[task.name];
      const lastRunAtMs =
        typeof legacyLastRun === "number" && Number.isFinite(legacyLastRun)
          ? legacyLastRun
          : undefined;
      const job = convergeTaskJob({
        agentId: agent.agentId,
        task,
        intervalMs,
        lastRunAtMs,
        existing,
        nowMs,
        monitor: plannedMonitor,
      });
      const sortOrder = reserveSortOrder(snapshot, existing);
      jobPlans.push({
        declarationKey,
        ...(existing ? { previous: structuredClone(existing) } : {}),
        job,
        sortOrder,
      });
    }
    if (blocked) {
      continue;
    }

    try {
      assertCronStoreCanPersist({ version: 1, jobs: jobPlans.map((plan) => plan.job) });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task jobs could not be planned: ${errorMessage(error)}. Scratch was left unchanged.`,
      );
      continue;
    }

    const plan: AgentTaskMigrationPlan = {
      monitor: plannedMonitor,
      scratchRevision,
      ...(monitor.state.scratch?.sourceSha256
        ? { sourceSha256: monitor.state.scratch.sourceSha256 }
        : {}),
      strippedContent: document.strippedContent,
      jobs: jobPlans,
    };
    let committed: MigrationCommitResult;
    try {
      committed = commitAgentTaskMigration({ storePath, env, nowMs, plan });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task migration could not be committed: ${errorMessage(error)}. Scratch and cron jobs were left unchanged.`,
      );
      continue;
    }
    if (!committed.ok) {
      warnings.push(
        committed.reason === "revision-conflict"
          ? `Agent "${agent.agentId}" scratch changed during task migration; no changes were committed.`
          : `Agent "${agent.agentId}" cron jobs changed during task migration; no changes were committed.`,
      );
      continue;
    }

    for (const jobPlan of jobPlans) {
      const index = snapshot.jobs.findIndex((job) => job.id === jobPlan.job.id);
      if (index >= 0) {
        snapshot.jobs[index] = jobPlan.job;
      } else {
        snapshot.jobs.push(jobPlan.job);
      }
      snapshot.sortOrderByJobId.set(jobPlan.job.id, jobPlan.sortOrder);
    }
    changes.push(
      `Converted ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} into cron jobs for agent "${agent.agentId}".`,
    );

    try {
      // Session task timestamps live in the per-agent database, so they cannot
      // join the state-DB commit. They are advisory once cron owns scheduling;
      // this idempotent cleanup may safely be retried or skipped after a crash.
      await clearLegacyTaskTimestamps({
        storePath: session.storePath,
        sessionKey: session.sessionKey,
        env,
        tasks: document.tasks,
        expectedSessionId: session.entry?.sessionId,
        expectedState: legacyState,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" legacy task timestamps could not be cleared after migration: ${errorMessage(error)}. Cron jobs remain authoritative and a rerun is safe.`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
