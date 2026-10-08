import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type QueueTranscriptOperation = <R>(
  operation: () => Promise<R>,
  signal?: AbortSignal,
) => Promise<R>;

/** Keep accepted work in the reservation after the callback closes its context. */
export async function withTranscriptLockSettlement<T>(
  run: (queue: QueueTranscriptOperation) => Promise<T> | T,
): Promise<T> {
  let accepting = true;
  let tail = Promise.resolve();
  const queue: QueueTranscriptOperation = (operation, signal) => {
    if (!accepting) {
      return Promise.reject(new Error("Transcript write context is closed"));
    }
    if (signal?.aborted) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve caller-owned AbortSignal reasons, including non-Error values.
      return Promise.reject(signal.reason);
    }
    let detach = () => {};
    const pending = tail.then(() => {
      detach();
      signal?.throwIfAborted();
      return operation();
    });
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    if (!signal) {
      return pending;
    }
    return new Promise((resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve caller-owned AbortSignal reasons, including non-Error values.
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
      void pending.then(resolve, reject);
    });
  };
  try {
    const result = run(queue);
    if (!isPromiseLike(result)) {
      accepting = false;
    }
    return await result;
  } finally {
    accepting = false;
    // Accepted persistence outlives scheduler cancellation and retains this reservation.
    await tail;
  }
}
