import { waitForActiveCronJobs } from "../cron/active-jobs.js";
import {
  abortActiveCronTaskRuns,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import type { getChildLogger } from "../logging.js";

const CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS = 10_000;

export async function drainGatewayCron(params: {
  exitWatchersStop: Promise<void>;
  streamWatchersStop: Promise<void>;
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}): Promise<void> {
  const abortedRuns = abortActiveCronTaskRuns("Gateway shutting down.");
  // Payload cleanup precedes durable finalization; both retain the old state owner.
  const [activeRunDrain, activeJobDrain, watchers] = await Promise.all([
    waitForActiveCronTaskRuns(CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS),
    waitForActiveCronJobs(CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS),
    Promise.allSettled([params.exitWatchersStop, params.streamWatchersStop]),
  ]);
  if (!activeRunDrain.drained || !activeJobDrain.drained) {
    params.logger.warn(
      { abortedRuns, activeRuns: activeRunDrain.active, activeJobs: activeJobDrain.active },
      "cron: active runs did not drain before shutdown timeout",
    );
  }
  for (const watcher of watchers) {
    if (watcher.status === "rejected") {
      throw watcher.reason;
    }
  }
}
