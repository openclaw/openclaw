import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isAbortError } from "../../infra/abort-signal.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createOpenClawStateWorkerLease } from "../../state/openclaw-state-worker-store.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronSchedulerResult } from "../store/scheduler-actor.types.js";
import { adoptCronRunRequests, drainCronRunQueue } from "./run-queue.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { captureCronSchedulerSnapshot } from "./scheduler-config.js";
import { runCronSchedulerMaintenance } from "./scheduler-maintenance.js";
import { emit, type CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";

type StartupOptions = { skipJobIds?: ReadonlySet<string>; deferAgentWork?: boolean };

async function publish(state: CronServiceState, result: CronSchedulerResult): Promise<void> {
  if (result.jobs.length > 0) {
    noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
    applyCronRuntimeRowsToState(state, result.jobs);
  }
  for (const entry of result.logs) {
    state.deps.log[entry.level](entry.fields, entry.message);
  }
  for (const job of result.ownerless) {
    emit(state, {
      jobId: job.id,
      action: "finished",
      job,
      status: "skipped",
      completionStatus: "failed",
      error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      runAtMs: job.state.lastRunAtMs,
      durationMs: 0,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
  await runPostPersistCronNotifications(state, result.notifications);
}

/** Exercise one worker command and join its real launcher without a background timer. */
async function runScheduler(state: CronServiceState, startup?: StartupOptions): Promise<void> {
  if (state.stopped || state.schedulingPaused) {
    return;
  }
  const generation = state.lifecycleGeneration;
  if (startup) {
    await ensureLoaded(state, { forceReload: true });
  } else {
    await runCronSchedulerMaintenance(state);
  }
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  const channelName = `cron-test.${randomUUID()}`;
  const storeKey = cronStoreKey(state.deps.storePath);
  const lease = createOpenClawStateWorkerLease(
    captureOpenClawStateWorkerContext(),
    async (scope) => {
      await scope.execute({ type: "cron.schedulerStop", input: { storeKey, channelName } });
    },
  );
  try {
    const snapshot = await captureCronSchedulerSnapshot(state);
    const result = await lease.execute({
      type: "cron.schedulerStart",
      input: {
        storeKey,
        channelName,
        snapshot: startup
          ? snapshot
          : { ...snapshot, config: { ...snapshot.config, cronEnabled: false } },
        nowMs: state.deps.nowMs(),
        monotonicMs: performance.now(),
        skipJobIds: startup?.skipJobIds ? [...startup.skipJobIds] : undefined,
        deferAgentWork: startup?.deferAgentWork ?? false,
      },
    });
    const scheduled = startup
      ? result
      : await lease.execute({
          type: "cron.schedulerTick",
          input: {
            storeKey,
            snapshot: await captureCronSchedulerSnapshot(state),
            nowMs: state.deps.nowMs(),
            monotonicMs: performance.now(),
          },
        });
    const requests = adoptCronRunRequests(state, scheduled.accepted, {
      source: startup ? "startup" : "scheduled",
    });
    await publish(state, scheduled);
    await drainCronRunQueue(state);
    const completed = await Promise.allSettled(requests.map((request) => request.completion));
    const failed = completed.find((completion) => completion.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
    await ensureLoaded(state, { forceReload: true });
  } finally {
    await lease.release();
  }
}

export async function onTimer(state: CronServiceState): Promise<void> {
  if (state.stopped || state.schedulingPaused) {
    return;
  }
  const scheduler = state.schedulerScope;
  const generation = state.lifecycleGeneration;
  let admission;
  try {
    admission = await beginGatewayRootWorkAdmissionWhenOpen("cron:test-tick", scheduler.signal);
  } catch (error) {
    if (
      error instanceof GatewayDrainingError ||
      (scheduler.signal.aborted && isAbortError(error))
    ) {
      return;
    }
    throw error;
  }
  try {
    if (state.lifecycleGeneration !== generation) {
      return;
    }
    const run = () => runScheduler(state);
    await admission.run(() =>
      state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run(),
    );
  } finally {
    admission.release();
  }
}

export function runMissedJobs(state: CronServiceState, options?: StartupOptions): Promise<void> {
  return runScheduler(state, options ?? {});
}
