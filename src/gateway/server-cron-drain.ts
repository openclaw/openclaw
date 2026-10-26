import { waitForActiveCronJobs } from "../cron/active-jobs.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../cron/config-revision.js";
import type { CronService } from "../cron/service.js";
import {
  abortActiveCronTaskRuns,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import type { CronJob } from "../cron/types.js";
import type { getChildLogger } from "../logging.js";
import type { createCronStreamWatchers } from "./cron-stream-watchers.js";

const CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS = 10_000;

export async function drainGatewayCron(params: {
  settlements: readonly Promise<unknown>[];
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}): Promise<void> {
  const abortedRuns = abortActiveCronTaskRuns();
  // Payload cleanup precedes durable finalization; both retain the old state owner.
  const [activeRunDrain, activeJobDrain, settlements] = await Promise.all([
    waitForActiveCronTaskRuns(CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS),
    waitForActiveCronJobs(CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS),
    Promise.allSettled(params.settlements),
  ]);
  if (!activeRunDrain.drained || !activeJobDrain.drained) {
    params.logger.warn(
      { abortedRuns, activeRuns: activeRunDrain.active, activeJobs: activeJobDrain.active },
      "cron: active runs did not drain before shutdown timeout",
    );
  }
  for (const settlement of settlements) {
    if (settlement.status === "rejected") {
      throw settlement.reason;
    }
  }
}

/** A teardown failure cannot turn an already committed update into a reported rollback. */
async function settleCronStreamStopAfterCommit(params: {
  jobId: string;
  stop: Promise<void> | undefined;
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}): Promise<void> {
  try {
    await params.stop;
  } catch (error) {
    // The owner retains its terminal diagnostic; post-commit routing retries teardown.
    params.logger.warn(
      { jobId: params.jobId, err: String(error) },
      "cron-stream: source teardown failed after committed update",
    );
  }
}

export function withObservedCronStreamState<T extends CronJob>(
  cron: Pick<CronService, "getJob">,
  job: T,
): T {
  if (job.schedule.kind !== "stream") {
    return job;
  }
  const current = cron.getJob(job.id);
  // Lifecycle routing can await teardown while another caller changes the job.
  // Keep this mutation's saved definition, and attach only its own source facts.
  const matches =
    current &&
    current.state.streamSourceIdentity === job.state.streamSourceIdentity &&
    resolveCronJobConfigRevision(current) === resolveCronJobConfigRevision(job);
  return {
    ...job,
    state: matches
      ? { ...current.state }
      : { ...job.state, streamStatus: undefined, streamError: undefined },
  };
}

/** Route only the committed update; rejected proposals keep their current source alive. */
export function bindCronStreamUpdate({
  cron,
  streamWatchers,
  reconcile,
  cancelDisabledExitWatcher,
  logger,
}: {
  cron: CronService;
  streamWatchers: ReturnType<typeof createCronStreamWatchers>;
  reconcile: (jobId: string) => Promise<void>;
  cancelDisabledExitWatcher: (
    job: CronJob,
    precondition?: Parameters<CronService["updateWithPrecondition"]>[2],
  ) => void;
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}) {
  const queueStreamStopAfterCommit = (previous: CronJob | undefined, current: CronJob) => {
    if (
      previous?.schedule.kind !== "stream" ||
      cron.getJob(current.id)?.state.streamSourceIdentity !== current.state.streamSourceIdentity ||
      (current.schedule.kind === "stream" &&
        current.state.streamSourceIdentity === previous.state.streamSourceIdentity)
    ) {
      return undefined;
    }
    // Commit rotates the source identity before old output can be admitted. Only
    // now interrupt the process; a pending or denied proposal leaves it running.
    // Adopt the committed identity so teardown failures belong to the saved job.
    return streamWatchers?.stop(
      current.id,
      current.schedule.kind === "stream" && current.state.streamRestartExhausted
        ? "restart-exhausted"
        : current.schedule.kind === "stream" && !current.enabled
          ? "disabled"
          : "schedule-update",
      current,
    );
  };
  const updateCronWithPrecondition = cron.updateWithPrecondition.bind(cron);
  return async (
    jobId: string,
    patch: Parameters<CronService["update"]>[1],
    opts?: Parameters<CronService["update"]>[2],
    precondition?: Parameters<CronService["updateWithPrecondition"]>[2],
  ) => {
    let previous: CronJob | undefined;
    const result = await updateCronWithPrecondition(
      jobId,
      patch,
      async (current, nowMs) => {
        await precondition?.(current, nowMs);
        previous = current;
      },
      opts,
    );
    if (patch.enabled === false) {
      cancelDisabledExitWatcher(result, precondition);
    }
    await settleCronStreamStopAfterCommit({
      jobId,
      stop: queueStreamStopAfterCommit(previous, result),
      logger,
    });
    await reconcile(jobId);
    return withObservedCronStreamState(cron, result);
  };
}

/** Refuse stale removals before stopping; retain the job until source cleanup is confirmed. */
export function bindCronStreamRemoval({
  cron,
  streamWatchers,
  reconcile,
}: {
  cron: CronService;
  streamWatchers: ReturnType<typeof createCronStreamWatchers>;
  reconcile: (jobId: string) => Promise<void>;
}): CronService["remove"] {
  const removeCron = cron.remove.bind(cron);
  return async (jobId, opts) => {
    opts?.commitGuard?.();
    const previous = cron.getJob(jobId);
    if (previous?.schedule.kind === "stream" && opts?.expectedConfigRevision !== undefined) {
      const actualConfigRevision = resolveCronJobConfigRevision(previous);
      if (actualConfigRevision !== opts.expectedConfigRevision) {
        throw new CronJobConfigRevisionConflictError(
          opts.expectedConfigRevision,
          actualConfigRevision,
        );
      }
    }
    try {
      if (previous?.schedule.kind === "stream") {
        await streamWatchers?.stop(jobId, "removed", previous);
      }
      const result = await removeCron(jobId, opts);
      if (!result.removed) {
        await reconcile(jobId);
      }
      return result;
    } catch (error) {
      // Preserve the original stop/removal error; recovery routing is advisory.
      await reconcile(jobId);
      throw error;
    }
  };
}
