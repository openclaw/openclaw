import { throwIfSettledRejected } from "../../infra/error-graph-internal.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../../sessions/session-controller.lifecycle.js";
import { settlesWithin } from "../../shared/settle-within.js";

export async function completeAbortRetirements<T>(
  run: () => Promise<T>,
  retirements: Promise<void>[],
): Promise<T> {
  const [outcome] = await Promise.allSettled([run()]);
  const [cleanup] = await Promise.allSettled([
    (async () => {
      const settlement = Promise.allSettled(retirements);
      if (!(await settlesWithin(settlement, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS))) {
        throw new Error(
          "Cancellation was requested, but cleanup is still pending. Check the turn status before retrying Stop.",
        );
      }
      throwIfSettledRejected(await settlement, "Cancellation cleanup failed");
    })(),
  ]);
  if (
    cleanup.status === "rejected" &&
    outcome.status === "rejected" &&
    cleanup.reason !== outcome.reason
  ) {
    throw new AggregateError([outcome.reason, cleanup.reason], "Cancellation cleanup failed");
  }
  if (cleanup.status === "rejected") {
    throw cleanup.reason;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
