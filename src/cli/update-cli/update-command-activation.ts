import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
  scheduleAbsoluteDeadline,
} from "../../utils/absolute-deadline.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

export class UpdateActivationTimeoutError extends UpdateCommandRecoveryPendingError {
  readonly reason = UPDATE_ACTIVATION_TIMEOUT_REASON;
  constructor(
    readonly root: string,
    readonly timeoutMs: number,
  ) {
    super(`Update activation exceeded its ${timeoutMs / 1000}-second budget.`);
    this.name = "UpdateActivationTimeoutError";
  }
}

/** The executor retains cancellation and settlement after its activation deadline. */
export function createUpdateActivationDeadline() {
  const controller = new AbortController();
  let cancelDeadline: (() => void) | undefined;
  let admission: { root: string; timeoutMs: number; deadlineAtMs: number } | undefined;
  let failure: UpdateActivationTimeoutError | undefined;
  let expire: (error: UpdateActivationTimeoutError) => void = () => {};
  const expired = new Promise<UpdateActivationTimeoutError>((resolve) => {
    expire = resolve;
  });
  const inspectDeadline = () => {
    if (!failure && admission && Date.now() >= admission.deadlineAtMs) {
      failure = new UpdateActivationTimeoutError(admission.root, admission.timeoutMs);
      controller.abort(failure);
      expire(failure);
    }
  };
  const assertCurrent = () => {
    inspectDeadline();
    controller.signal.throwIfAborted();
  };
  return {
    signal: controller.signal,
    assertCurrent,
    start(root: string, timeoutMs: number) {
      assertCurrent();
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Update activation requires a finite positive budget.");
      }
      if (admission) {
        return;
      }
      admission = { root, timeoutMs, deadlineAtMs: Date.now() + timeoutMs };
      cancelDeadline = scheduleAbsoluteDeadline(admission.deadlineAtMs, inspectDeadline);
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const work = Promise.resolve()
        .then(operation)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        const outcome = await Promise.race([work, expired]);
        inspectDeadline();
        const timeout = failure;
        if (timeout) {
          // Reuse the caller's phase budget for joining cancelled work. Expiry
          // never supplies the process-exit evidence required to release a lease.
          const joined = await awaitWithinDeadline(
            () => work,
            admission!.deadlineAtMs + timeout.timeoutMs,
          );
          timeout.message +=
            joined === ABSOLUTE_DEADLINE_EXPIRED
              ? " Cancellation did not settle within the same budget; outstanding writers retain update ownership."
              : " The update operation returned after cancellation; any unconfirmed ownership remains retained.";
          throw timeout;
        }
        if (outcome instanceof UpdateActivationTimeoutError) {
          throw outcome;
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.value;
      } finally {
        cancelDeadline?.();
      }
    },
  };
}
