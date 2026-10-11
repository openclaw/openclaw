/** Doctor-owned migration from heartbeat scratch `tasks:` blocks into cron jobs. */
import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordConvertedProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import type { CronJobScratchState } from "../cron/scratch-contract.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
  projectCronJobThroughStorageCodec,
} from "../cron/store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "../cron/store/runtime-authority-store.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { shortenHomePath } from "../utils.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { resolveHeartbeatConfig } from "./doctor-heartbeat-legacy.js";
import { resolveHeartbeatSession } from "./doctor-heartbeat-session.js";
import { isHeartbeatTaskCronJob } from "./doctor-heartbeat-task-identity.js";
import {
  commitHeartbeatTaskMigrationInDatabase,
  convertStoredHeartbeatTask,
  loadHeartbeatTaskPlanningSnapshot,
  planHeartbeatTaskMigration,
  validateHeartbeatTasks,
  type AgentTaskMigrationPlan,
  type CronPlanningSnapshot,
  type MigrationCommitResult,
} from "./doctor-heartbeat-task-migration.kernel.js";
import { readLegacyHeartbeatScratch } from "./doctor-heartbeat-task-scratch.js";
import { noteDoctorMigrationResult } from "./doctor-migration-notes.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

type HeartbeatTaskMigrationResult = { changes: string[]; warnings: string[] };

function resolveHeartbeatTaskMigrationAgents(cfg: OpenClawConfig) {
  return listAgentIds(cfg).map((agentId) => ({
    agentId,
    heartbeat: resolveHeartbeatConfig(cfg, agentId),
  }));
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
    const finding = { ...MIGRATION_FINDING_DEFAULTS, path: storePath, target: agent.agentId };
    let monitor: ReturnType<typeof readLegacyHeartbeatScratch>;
    try {
      monitor = readLegacyHeartbeatScratch(storePath, agent.agentId, { env });
    } catch (error) {
      findings.push({
        ...finding,
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
      validateHeartbeatTasks(document.tasks, document.taskEntryCount);
      findings.push({
        ...finding,
        requirement: "heartbeat-tasks-in-scratch",
        message: `Agent "${agent.agentId}" has ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} that must become cron jobs.`,
      });
    } catch (error) {
      findings.push({
        ...finding,
        requirement: "heartbeat-task-migration-blocked",
        severity: "error",
        message: `Agent "${agent.agentId}" heartbeat tasks cannot be migrated: ${errorMessage(error)}`,
      });
    }
  }
  return findings;
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
        const monitorAgentId = monitor
          ? tryResolveCronJobEffectiveAgentId(monitor, tryResolveAmbientOwnerAgentId(cfg))
          : undefined;
        if (!monitor || !monitorAgentId || monitorAgentId !== job.agentId) {
          throw new Error(
            `Legacy task ${job.id} has no unambiguous monitor owner; preserve its input and resolve the owner before rerunning Doctor.`,
          );
        }
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, monitorAgentId);
        if (receipt?.phase !== "pending" || receipt.jobId !== monitor.id) {
          throw new Error(`Heartbeat task ${job.id} no longer has a pending cutover owner`);
        }
        if (job.state.runningAtMs !== undefined) {
          throw new Error(
            `Legacy task ${job.id} is running; stop the Gateway before Doctor cutover.`,
          );
        }
        const convertedJob = convertStoredHeartbeatTask(job, monitor, Date.now());
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
        recordConvertedProactiveJobInDatabase(db, storePath, monitorAgentId, convertedJob.id);
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
  return loadHeartbeatTaskPlanningSnapshot(openOpenClawStateDatabase({ env }).db, storePath);
}

async function clearLegacyTaskTimestamps(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  tasks: readonly LegacyHeartbeatTask[];
  expectedSessionId?: string;
  expectedState: Record<string, number>;
}): Promise<void> {
  await patchSessionEntryCore(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      env: params.env,
    },
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
    jobId: string;
    scratch: NonNullable<CronJobScratchState["scratch"]>;
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
    try {
      validateHeartbeatTasks(tasks, document.taskEntryCount);
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
      jobId: monitor.jobId,
      scratch,
    });
  }

  if (!params.shouldRepair || candidates.length === 0) {
    noteDoctorMigrationResult({ warnings });
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
    const { agent, document, jobId, scratch } = candidate;
    const session = resolveHeartbeatSession(
      params.cfg,
      agent.agentId,
      agent.heartbeat,
      undefined,
      env,
    );
    const legacyState = session.entry?.heartbeatTaskState ?? {};
    let plan: AgentTaskMigrationPlan;
    try {
      plan = planHeartbeatTaskMigration({
        snapshot,
        defaultAgentId: tryResolveAmbientOwnerAgentId(params.cfg),
        agentId: agent.agentId,
        jobId,
        scratch,
        legacyTaskState: legacyState,
        nowMs,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task jobs could not be planned: ${errorMessage(error)}. Scratch was left unchanged.`,
      );
      continue;
    }
    let committed: MigrationCommitResult;
    try {
      committed = runOpenClawStateWriteTransaction(
        ({ db }) =>
          commitHeartbeatTaskMigrationInDatabase({
            db,
            storePath,
            defaultAgentId: tryResolveAmbientOwnerAgentId(params.cfg),
            nowMs,
            plan,
          }),
        { env },
        { operationLabel: "doctor.heartbeat-task-migration" },
      );
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

    for (const jobPlan of plan.jobs) {
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
        agentId: agent.agentId,
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

  noteDoctorMigrationResult({ changes, warnings });
  return { changes, warnings };
}
