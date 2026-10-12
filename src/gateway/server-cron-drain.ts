import { waitForActiveCronJobs } from "../cron/active-jobs.js";
import {
  abortActiveCronTaskRuns,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import type { getChildLogger } from "../logging.js";

const CRON_ACTIVE_RUN_SHUTDOWN_DRAIN_MS = 10_000;

export async function drainGatewayCron(params: {
  settlements: readonly Promise<unknown>[];
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}): Promise<void> {
  const abortedRuns = abortActiveCronTaskRuns("Gateway shutting down.");
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
