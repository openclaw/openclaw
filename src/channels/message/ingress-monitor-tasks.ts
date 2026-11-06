import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { sleep } from "../../utils/sleep.js";

export async function appendIngressWithRetry<T>(
  append: () => Promise<T>,
  delaysMs: readonly number[] = [0, 100, 300],
): Promise<T> {
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      return await append();
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  // Accepted transport input must fail closed if every durable append attempt fails.
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(
    lastError === undefined
      ? "Channel ingress append failed without an error."
      : formatErrorMessage(lastError),
    { cause: lastError },
  );
}

/** Join the monitor-owned task collection, including work added while awaiting it. */
export async function waitForPending(
  read: () => Iterable<Promise<unknown>>,
  reject = false,
): Promise<void> {
  for (;;) {
    const pending = [...read()];
    if (pending.length === 0) {
      return;
    }
    await (reject ? Promise.all(pending) : Promise.allSettled(pending));
  }
}

/** Serialize admission and claim work without deferring the first task. */
export function createAdmissionClaimLock() {
  let admissionClaimLocked = false;
  const admissionClaimWaiters: Array<() => void> = [];
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = (): Promise<T> => {
      admissionClaimLocked = true;
      let result: Promise<T>;
      try {
        result = Promise.resolve(task());
      } catch (error) {
        result = Promise.reject(toErrorObject(error, "Channel ingress admission task failed"));
      }
      return result.finally(() => {
        const next = admissionClaimWaiters.shift();
        if (next) {
          next();
        } else {
          admissionClaimLocked = false;
        }
      });
    };
    if (!admissionClaimLocked) {
      return run();
    }
    return new Promise<T>((resolve, reject) => {
      admissionClaimWaiters.push(() => {
        void run().then(resolve, reject);
      });
    });
  };
}
