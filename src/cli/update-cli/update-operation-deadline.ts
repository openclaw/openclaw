import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
  scheduleAbsoluteDeadline,
} from "../../utils/absolute-deadline.js";

/** Cancellation revokes this operation before bounded settlement and caller recovery. */
export function createUpdateOperationDeadline<E extends Error = Error>(
  onExpired?: (error: E) => void,
) {
  const controller = new AbortController();
  let closed = false;
  let cancelDeadline: (() => void) | undefined;
  let admission: { error: E; timeoutMs: number; deadlineAtMs: number } | undefined;
  let failure: E | undefined;
  let expire: (error: E) => void = () => {};
  const expired = new Promise<{ error: E }>((resolve) => {
    expire = (error) => resolve({ error });
  });
  const inspectDeadline = () => {
    if (!closed && !failure && admission && Date.now() >= admission.deadlineAtMs) {
      failure = admission.error;
      try {
        onExpired?.(failure);
      } catch (error) {
        failure.cause = error;
        failure.message += " Cancellation could not be requested completely.";
      } finally {
        controller.abort(failure);
        expire(failure);
      }
    }
  };
  const assertCurrent = () => {
    if (closed) {
      throw failure ?? new Error("Update operation ownership has closed.");
    }
    inspectDeadline();
    if (failure) {
      throw failure;
    }
    controller.signal.throwIfAborted();
  };
  return {
    signal: controller.signal,
    assertCurrent,
    get failure() {
      return failure;
    },
    start(error: E, timeoutMs: number) {
      assertCurrent();
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Update operation requires a finite positive budget.");
      }
      if (admission) {
        return;
      }
      admission = { error, timeoutMs, deadlineAtMs: Date.now() + timeoutMs };
      cancelDeadline = scheduleAbsoluteDeadline(admission.deadlineAtMs, inspectDeadline);
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      return await withCommandProcessScope(async () => {
        assertCurrent();
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
            const joined = await awaitWithinDeadline(
              () => work,
              admission!.deadlineAtMs + admission!.timeoutMs,
            );
            timeout.message +=
              joined === ABSOLUTE_DEADLINE_EXPIRED
                ? " Cancellation did not settle within the same budget; outstanding writers retain update ownership."
                : " Cancellation settled before recovery.";
            if (
              joined !== ABSOLUTE_DEADLINE_EXPIRED &&
              "error" in joined &&
              hasCommandProcessCleanupError(joined.error)
            ) {
              throw new AggregateError([timeout, joined.error], "Update operation cleanup failed", {
                cause: timeout,
              });
            }
            throw timeout;
          }
          if ("error" in outcome) {
            throw outcome.error;
          }
          return outcome.value;
        } finally {
          closed = true;
          cancelDeadline?.();
        }
      }, controller.signal);
    },
  };
}
