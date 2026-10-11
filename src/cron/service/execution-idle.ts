import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { onGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { markCronJobWaitingForIdle, type CronActiveJobMarker } from "../active-jobs.js";
import type { CronJob } from "../types.js";
import { captureCronCapacityLease } from "./run-admission-capacity.js";
import type { CronServiceState } from "./state.js";

/** Retain source custody while existing execution owners settle, without owning capacity. */
export async function waitForCronExecutionIdle(
  state: CronServiceState,
  job: CronJob,
  options: {
    activeJobMarker: CronActiveJobMarker | undefined;
    ownSessionKey?: string;
    ownReplyOperation?: ReplyOperation;
    signal: AbortSignal;
    assertCurrent: () => void | Promise<void>;
  },
): Promise<void> {
  const signal = AbortSignal.any([options.signal, state.schedulerScope.signal]);
  const capacity = captureCronCapacityLease();
  signal.throwIfAborted();
  await options.assertCurrent();
  signal.throwIfAborted();
  capacity?.suspend();
  const endWait = markCronJobWaitingForIdle(options.activeJobMarker, options.ownReplyOperation);
  let changed = createDeferredCore();
  const unsubscribe = onGatewayWorkMetricsChanged(() => changed.resolve());
  try {
    for (;;) {
      signal.throwIfAborted();
      const observed = changed;
      if (
        state.deps.isExecutionIdle?.(job, options.ownSessionKey, options.ownReplyOperation) !==
        false
      ) {
        await capacity?.resume(signal);
        await options.assertCurrent();
        signal.throwIfAborted();
        if (
          state.deps.isExecutionIdle?.(job, options.ownSessionKey, options.ownReplyOperation) !==
          false
        ) {
          // Claim readiness synchronously so the next resumed waiter observes this owner.
          endWait();
          return;
        }
        capacity?.suspend();
      }
      await racePromiseWithAbortSignal(observed.promise, signal);
      if (changed === observed) {
        changed = createDeferredCore();
      }
    }
  } finally {
    unsubscribe();
    endWait();
  }
}
