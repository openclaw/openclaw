import { BroadcastChannel } from "node:worker_threads";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  isTimeScheduledJob,
  needsCronTimerMaintenance,
  recomputeJobNextRunAtMs,
  resolveJobErrorBackoffUntilMs,
  resolveNextRunAtMsOrDisable,
} from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  MAX_CRON_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
} from "../service/timer-execution-timeout.js";
import { hasMissedCronSlotSinceLastRun, isRunnableJob } from "../service/timer-runnable.js";
import type { CronJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import { loadedCronStoreFromRows, loadCronRows, updateCronRuntimeRow } from "./row-codec.js";
import { requestAndDrainCronRunsInWorker } from "./run-queue.worker.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "./run-receipt-store.js";
import { createCronScheduledRunId } from "./run-request-id.js";
import { scheduleUnownedCronJobsInWorker } from "./runtime-maintenance.worker.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type {
  CronSchedulerOperations,
  CronSchedulerResult,
  CronSchedulerSnapshot,
  CronSchedulerWake,
} from "./scheduler-actor.types.js";
import {
  getCronSchedulerSnapshot,
  installCronSchedulerSnapshot,
  removeCronSchedulerSnapshot,
} from "./scheduler-config.worker.js";
import { recordSkippedCronRunsInWorker } from "./scheduler-state.worker.js";

type SchedulerActor = {
  storeKey: string;
  databasePath: string;
  channels: Map<string, { channel: BroadcastChannel; paused: boolean }>;
  timer?: ReturnType<typeof setTimeout>;
  lastWallMs?: number;
  lastMonotonicMs?: number;
  wakeAtMs?: number;
  catchupNeeded?: boolean;
  startupBatch?: {
    immediateReceiptIds: Map<string, string>;
    overflow: Map<string, StartupOverflow>;
  };
};

type StartupOverflow = {
  catchupAtMs: number;
  delayMs: number;
  lastRunAtMs: number | undefined;
};

const actors = new Map<string, SchedulerActor>();

function emptyResult(): CronSchedulerResult {
  return {
    jobs: [],
    ownerless: [],
    accepted: [],
    rejected: [],
    launches: [],
    preparing: [],
    skipped: [],
    notifications: [],
    logs: [],
  };
}

function readJobs(database: OpenClawStateDatabase, storeKey: string): CronJob[] {
  return loadedCronStoreFromRows(
    loadCronRows(database.db, storeKey, undefined, { includeGrantDefinitionProjection: true }),
  ).store.jobs;
}

function waitsForStartupBatch(actor: SchedulerActor, job: CronJob): boolean {
  const pending = actor.startupBatch?.overflow.get(job.id);
  return (
    pending !== undefined &&
    job.state.nextRunAtMs === pending.catchupAtMs &&
    job.state.startupCatchupAtMs === pending.catchupAtMs &&
    job.state.lastRunAtMs === pending.lastRunAtMs
  );
}

/** Overflow starts after the immediate batch settles, including completion in another service. */
export function settleCronStartupBatchInWorker(
  database: OpenClawStateDatabase,
  storeKey: string,
  nowMs: number,
): CronSchedulerResult {
  const actor = actors.get(JSON.stringify([database.path, storeKey]));
  const batch = actor?.startupBatch;
  const result = emptyResult();
  if (!actor || !batch) {
    return result;
  }
  const active = readActiveCronRunReceiptsInDatabase(database.db, storeKey, [
    ...batch.immediateReceiptIds.values(),
  ]);
  if (active.some((receipt) => batch.immediateReceiptIds.has(receipt.receiptId))) {
    return result;
  }
  const state: CronJobPolicyContext = {
    deps: { nowMs: () => nowMs, log: createCronMutationLogger(result.logs) },
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const jobs = loadedCronStoreFromRows(
        loadCronRows(db, storeKey, new Set(batch.overflow.keys())),
      ).store.jobs;
      for (const job of jobs) {
        const pending = batch.overflow.get(job.id);
        if (
          !pending ||
          job.state.nextRunAtMs !== pending.catchupAtMs ||
          job.state.startupCatchupAtMs !== pending.catchupAtMs
        ) {
          continue;
        }
        const previousEnabled = job.enabled ?? true;
        if (job.state.lastRunAtMs !== pending.lastRunAtMs) {
          // A manual run consumed this catch-up while preserving its own cadence.
          job.state.startupCatchupAtMs = undefined;
        } else {
          job.state.nextRunAtMs = resolveNextRunAtMsOrDisable({
            state,
            job,
            candidate: nowMs + pending.delayMs,
            deferredNotifications: result.notifications,
          });
          job.state.startupCatchupAtMs = job.state.nextRunAtMs;
        }
        updateCronRuntimeRow(db, storeKey, job, previousEnabled);
        result.jobs.push(job);
      }
      deferSqlitePostCommitPublication(db, () => {
        actor.startupBatch = undefined;
      });
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.startup-batch-settlement" },
  );
  for (const notification of result.notifications) {
    notification.routing = {
      defaultAgentId: getCronSchedulerSnapshot(storeKey, database.path)?.config.defaultAgentId,
    };
  }
  return result;
}

function collectChanges(
  result: CronSchedulerResult,
  change: Pick<CronSchedulerResult, "jobs" | "notifications" | "logs">,
) {
  result.jobs.push(...change.jobs);
  result.notifications.push(...change.notifications);
  result.logs.push(...change.logs);
}

function scheduleWake(
  storeKey: string,
  actor: SchedulerActor,
  delayMs: number,
  deadlineAtMs?: number,
): void {
  actor.timer = setTimeout(() => {
    actor.timer = undefined;
    if (deadlineAtMs !== undefined && Date.now() < deadlineAtMs) {
      scheduleWake(
        storeKey,
        actor,
        Math.min(deadlineAtMs - Date.now(), MAX_CRON_TIMER_DELAY_MS),
        deadlineAtMs,
      );
      return;
    }
    const wake: CronSchedulerWake = { type: "cron.schedulerWake", storeKey };
    for (const { channel } of actor.channels.values()) {
      const notify = channel.postMessage.bind(channel);
      notify(wake);
    }
    // Admission can be temporarily closed. Retry the notification without retaining
    // a database handle or performing work under the previous command's admission.
    scheduleWake(storeKey, actor, MAX_CRON_TIMER_DELAY_MS);
  }, delayMs);
  actor.timer.unref();
}

function armActor(
  storeKey: string,
  actor: SchedulerActor,
  snapshot: CronSchedulerSnapshot,
  jobs: CronJob[],
  nowMs: number,
): number | undefined {
  clearTimeout(actor.timer);
  actor.timer = undefined;
  actor.wakeAtMs = undefined;
  if (!snapshot.config.cronEnabled || ![...actor.channels.values()].some(({ paused }) => !paused)) {
    return undefined;
  }
  let nextWakeAtMs: number | undefined;
  let enabled = false;
  for (const job of jobs) {
    if (
      !isJobEnabled(job) ||
      !isTimeScheduledJob(job) ||
      !hasCanonicalCronDeliveryMode(job.delivery)
    ) {
      continue;
    }
    enabled = true;
    if (
      !hasActiveCronRun(job, false) &&
      !waitsForStartupBatch(actor, job) &&
      hasScheduledNextRunAtMs(job.state.nextRunAtMs)
    ) {
      nextWakeAtMs = Math.min(nextWakeAtMs ?? Infinity, job.state.nextRunAtMs);
    }
  }
  if (!enabled) {
    return undefined;
  }
  const delay =
    nextWakeAtMs === undefined ? MAX_CRON_TIMER_DELAY_MS : Math.max(0, nextWakeAtMs - nowMs);
  const wakeAtMs = nowMs + (delay === 0 ? MIN_REFIRE_GAP_MS : delay);
  actor.wakeAtMs = wakeAtMs;
  // Observe wall-clock changes without reloading SQL every minute. Native timers
  // alone cannot notice a clock step or suspend on every supported platform.
  scheduleWake(storeKey, actor, Math.min(wakeAtMs - nowMs, MAX_CRON_TIMER_DELAY_MS), wakeAtMs);
  return nextWakeAtMs ?? wakeAtMs;
}

function isAgentWork(job: CronJob): boolean {
  return job.payload.kind === "agentTurn" || job.payload.kind === "systemEvent";
}

function boundedCatchup(
  database: OpenClawStateDatabase,
  actor: SchedulerActor,
  storeKey: string,
  snapshot: CronSchedulerSnapshot,
  nowMs: number,
  result: CronSchedulerResult,
  jobs: ReadonlyMap<string, CronJob>,
  options?: { skipJobIds?: string[]; deferAgentWork?: boolean },
): { immediate: CronJob[]; overflow: Map<string, StartupOverflow> } {
  if (jobs.size === 0) {
    return { immediate: [], overflow: new Map() };
  }
  const { config } = snapshot;
  const maxImmediate = Math.max(
    0,
    config.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  const staggerMs = Math.max(0, config.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
  const agentDelayMs = Math.max(
    0,
    config.startupDeferredMissedAgentJobDelayMs ??
      DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  );
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const active = listActiveCronRunReceiptJobIdsInDatabase(db, storeKey);
      const skipped = new Set(options?.skipJobIds);
      const previousEnabled = new Map(
        [...jobs.values()].map((job) => [job.id, job.enabled ?? true]),
      );
      const changed: CronJob[] = [];
      const notifications: CronSchedulerResult["notifications"] = [];
      const state: CronJobPolicyContext = {
        deps: { nowMs: () => nowMs, log: createCronMutationLogger(result.logs) },
      };
      const missed: CronJob[] = [];
      for (const job of jobs.values()) {
        if (
          !isJobEnabled(job) ||
          skipped.has(job.id) ||
          waitsForStartupBatch(actor, job) ||
          active.has(job.id) ||
          hasActiveCronRun(job, false)
        ) {
          continue;
        }
        const backoff =
          job.schedule.kind === "cron"
            ? resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS)
            : undefined;
        if (
          backoff !== undefined &&
          nowMs < backoff &&
          hasMissedCronSlotSinceLastRun(job, nowMs) &&
          job.state.nextRunAtMs !== backoff
        ) {
          job.state.nextRunAtMs = backoff;
          changed.push(job);
          continue;
        }
        if (
          !isRunnableJob({
            job,
            nowMs,
            skipAtIfAlreadyRan: true,
            allowCronMissedRunByLastRun: true,
            activeInProcess: false,
          })
        ) {
          continue;
        }
        if (
          config.cronConfig?.skipMissedJobs &&
          (job.schedule.kind === "cron" || job.schedule.kind === "every")
        ) {
          if (
            recomputeJobNextRunAtMs({ state, job, nowMs, deferredNotifications: notifications })
          ) {
            changed.push(job);
          }
        } else {
          missed.push(job);
        }
      }
      missed.sort((left, right) => (left.state.nextRunAtMs ?? 0) - (right.state.nextRunAtMs ?? 0));
      const eligible = options?.deferAgentWork ? missed.filter((job) => !isAgentWork(job)) : missed;
      const immediate = eligible.slice(0, maxImmediate);
      const deferred = [
        ...eligible.slice(maxImmediate).map((job) => ({ job, delayMs: undefined })),
        ...(options?.deferAgentWork
          ? missed.filter(isAgentWork).map((job) => ({ job, delayMs: agentDelayMs }))
          : []),
      ];
      const overflow = new Map<string, StartupOverflow>();
      for (const [index, { job, delayMs }] of deferred.entries()) {
        const candidate = nowMs + (delayMs ?? staggerMs) + index * staggerMs;
        job.state.nextRunAtMs = resolveNextRunAtMsOrDisable({
          state,
          job,
          candidate,
          deferredNotifications: notifications,
        });
        job.state.startupCatchupAtMs = job.state.nextRunAtMs;
        if (delayMs === undefined && job.state.nextRunAtMs !== undefined) {
          overflow.set(job.id, {
            catchupAtMs: job.state.nextRunAtMs,
            delayMs: (index + 1) * staggerMs,
            lastRunAtMs: job.state.lastRunAtMs,
          });
        }
        changed.push(job);
      }
      if (deferred.length > 0) {
        result.logs.push({
          level: "info",
          fields: {
            immediateCount: immediate.length,
            deferredCount: deferred.length,
            totalMissed: missed.length,
          },
          message: "cron: staggering missed jobs to prevent gateway overload",
        });
      }
      for (const notification of notifications) {
        notification.routing = { defaultAgentId: config.defaultAgentId };
      }
      result.jobs.push(...changed);
      result.notifications.push(...notifications);
      for (const job of changed) {
        updateCronRuntimeRow(db, storeKey, job, previousEnabled.get(job.id));
      }
      return { immediate, overflow };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.scheduler-catchup" },
  );
}

export function runCronSchedulerInWorker(
  database: OpenClawStateDatabase,
  command: {
    [Type in "cron.schedulerStart" | "cron.schedulerTick" | "cron.schedulerRefresh"]: {
      type: Type;
      input: CronSchedulerOperations[Type]["input"];
    };
  }["cron.schedulerStart" | "cron.schedulerTick" | "cron.schedulerRefresh"],
): CronSchedulerResult {
  const { input } = command;
  const key = JSON.stringify([database.path, input.storeKey]);
  let actor = actors.get(key);
  const starting = !actor && command.type === "cron.schedulerStart";
  if (!actor && command.type !== "cron.schedulerStart") {
    return emptyResult();
  }
  if (!actor) {
    actor = { storeKey: input.storeKey, databasePath: database.path, channels: new Map() };
    actors.set(key, actor);
  }
  if (command.type === "cron.schedulerStart" && !actor.channels.has(command.input.channelName)) {
    const channel = new BroadcastChannel(command.input.channelName);
    channel.unref();
    actor.channels.set(command.input.channelName, {
      channel,
      paused: command.input.paused ?? false,
    });
  }
  if (command.type !== "cron.schedulerStart" && command.input.channelName) {
    const subscriber = actor.channels.get(command.input.channelName);
    if (subscriber && command.input.paused !== undefined) {
      subscriber.paused = command.input.paused;
    }
  }
  const snapshot = input.snapshot
    ? installCronSchedulerSnapshot(input.storeKey, input.snapshot, database.path)
    : getCronSchedulerSnapshot(input.storeKey, database.path);
  if (!snapshot) {
    throw new Error("Cron scheduler requires a configuration snapshot");
  }
  const nowMs =
    input.nowMs ??
    (command.type === "cron.schedulerRefresh" ? command.input.options?.nowMs : undefined) ??
    Date.now();
  const monotonicMs = input.monotonicMs ?? performance.now();
  const elapsedWallMs = actor.lastWallMs === undefined ? 0 : nowMs - actor.lastWallMs;
  const elapsedMonotonicMs =
    actor.lastMonotonicMs === undefined ? 0 : monotonicMs - actor.lastMonotonicMs;
  actor.catchupNeeded ||=
    elapsedWallMs - elapsedMonotonicMs > MIN_REFIRE_GAP_MS ||
    (actor.wakeAtMs !== undefined && nowMs > actor.wakeAtMs + MIN_REFIRE_GAP_MS);
  const forwardJump = actor.catchupNeeded;
  const result = emptyResult();
  collectChanges(result, settleCronStartupBatchInWorker(database, input.storeKey, nowMs));
  // This synchronous worker command owns all intervening writes. Fold their
  // postimages into the loaded rows before selecting maintenance and the next wake.
  const jobs = new Map(readJobs(database, input.storeKey).map((job) => [job.id, job]));
  const currentJobs = () => {
    for (const job of result.jobs) {
      jobs.set(job.id, job);
    }
    return [...jobs.values()];
  };
  if (
    snapshot.config.cronEnabled &&
    (command.type === "cron.schedulerRefresh" ||
      [...actor.channels.values()].some(({ paused }) => !paused))
  ) {
    let candidates: CronJob[] = [];
    let overflow = new Map<string, StartupOverflow>();
    if (starting || (command.type === "cron.schedulerTick" && forwardJump)) {
      const catchup = boundedCatchup(
        database,
        actor,
        input.storeKey,
        snapshot,
        nowMs,
        result,
        jobs,
        command.type === "cron.schedulerStart" ? command.input : undefined,
      );
      candidates = catchup.immediate;
      overflow = catchup.overflow;
    } else if (command.type !== "cron.schedulerRefresh") {
      candidates = currentJobs().filter(
        (job) =>
          !waitsForStartupBatch(actor, job) &&
          isRunnableJob({ job, nowMs, activeInProcess: false }),
      );
    }
    const ownerless = candidates.filter(
      (job) => !tryResolveCronJobEffectiveAgentId(job, snapshot.config.defaultAgentId),
    );
    if (ownerless.length > 0) {
      const skipped = recordSkippedCronRunsInWorker(
        database,
        {
          storeKey: input.storeKey,
          change: {
            kind: "ownerless",
            proposals: ownerless.map((job) => ({
              jobId: job.id,
              enabled: job.enabled,
              configRevision: resolveCronJobConfigRevision(job),
              nextRunAtMs: job.state.nextRunAtMs,
              lastRunAtMs: job.state.lastRunAtMs,
              lastRunStatus: job.state.lastRunStatus,
            })),
          },
          snapshot: {
            nowMs,
            defaultAgentId: snapshot.config.defaultAgentId,
            cronConfig: snapshot.config.cronConfig,
            notificationRouting: { defaultAgentId: snapshot.config.defaultAgentId },
            ownership: [],
          },
        },
        { recordHistory: true },
      ).outcome;
      collectChanges(result, skipped);
      result.ownerless.push(...skipped.jobs);
    }
    const owned = candidates.filter(
      (job) => !ownerless.includes(job) && hasScheduledNextRunAtMs(job.state.nextRunAtMs),
    );
    if (
      command.type !== "cron.schedulerRefresh" &&
      (owned.length > 0 ||
        (input.requests?.length ?? 0) > 0 ||
        currentJobs().some((job) => job.state.queuedAtMs !== undefined))
    ) {
      currentJobs();
      const requested = requestAndDrainCronRunsInWorker(
        database,
        {
          storeKey: input.storeKey,
          nowMs,
          defaultAgentId: snapshot.config.defaultAgentId,
          requests: owned.map((job) => ({
            mode: "scheduled",
            jobId: job.id,
            configRevision: resolveCronJobConfigRevision(job),
            scheduledSlotMs: job.state.nextRunAtMs,
            receiptId: createCronScheduledRunId(input.storeKey, job.id, job.state.nextRunAtMs!),
          })),
        },
        {
          requests: input.requests ?? [],
          maxConcurrentRuns: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
          schedulingPaused: input.paused,
          preparingAgentIds: snapshot.config.preparingAgentIds,
          hostProcessId: snapshot.config.hostProcessId,
        },
        jobs,
      );
      result.accepted.push(...requested.accepted);
      result.rejected.push(...requested.rejected);
      result.launches.push(...requested.launches);
      result.preparing.push(...requested.preparing);
      result.skipped.push(...requested.skipped);
      result.jobs.push(...requested.accepted.map((entry) => entry.job));
      result.jobs.push(...requested.launches.map((entry) => entry.job));
      result.jobs.push(...requested.skipped.flatMap((entry) => (entry.job ? [entry.job] : [])));
    }
    if (overflow.size > 0 && (actor.startupBatch || result.accepted.length > 0)) {
      actor.startupBatch ??= { immediateReceiptIds: new Map(), overflow: new Map() };
      for (const entry of result.accepted) {
        actor.startupBatch.immediateReceiptIds.set(entry.runReceipt.receiptId, entry.job.id);
      }
      for (const [id, pending] of overflow) {
        actor.startupBatch.overflow.set(id, pending);
      }
    }
    // Due work is selected before maintenance; backward clock movement never
    // recomputes a valid future deadline or rewinds an already-consumed slot.
    const options = {
      recomputeExpired: command.type !== "cron.schedulerRefresh",
      repairFutureCronNextRunAtMs: command.type !== "cron.schedulerRefresh" && elapsedWallMs >= 0,
      ...(command.type === "cron.schedulerRefresh" ? command.input.options : undefined),
    };
    if (currentJobs().some((job) => needsCronTimerMaintenance(job, nowMs, options))) {
      collectChanges(
        result,
        scheduleUnownedCronJobsInWorker(database, {
          storeKey: input.storeKey,
          options,
          snapshot: { nowMs },
        }).outcome,
      );
    }
  }
  result.jobs = [...new Map(result.jobs.map((job) => [job.id, job])).values()];
  result.nextWakeAtMs = armActor(input.storeKey, actor, snapshot, currentJobs(), nowMs);
  if (command.type !== "cron.schedulerRefresh") {
    actor.catchupNeeded = false;
    actor.lastWallMs = nowMs;
    actor.lastMonotonicMs = monotonicMs;
  }
  return result;
}

export function stopCronSchedulerInWorker(
  input: CronSchedulerOperations["cron.schedulerStop"]["input"],
): void {
  const entry = [...actors].find(
    ([, actor]) => actor.storeKey === input.storeKey && actor.channels.has(input.channelName),
  );
  if (!entry) {
    return;
  }
  const [key, actor] = entry;
  actor.channels.get(input.channelName)?.channel.close();
  actor.channels.delete(input.channelName);
  if (actor.channels.size === 0) {
    clearTimeout(actor.timer);
    actors.delete(key);
    removeCronSchedulerSnapshot(input.storeKey, actor.databasePath);
  }
}
