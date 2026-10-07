import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type QueueTranscriptOperation = <R>(operation: () => Promise<R>) => Promise<R>;

/** Keep accepted work in the reservation after the callback closes its context. */
export async function withTranscriptLockSettlement<T>(
  run: (queue: QueueTranscriptOperation) => Promise<T> | T,
): Promise<T> {
  let accepting = true;
  let tail = Promise.resolve();
  const queue: QueueTranscriptOperation = (operation) => {
    if (!accepting) {
      return Promise.reject(new Error("Transcript write context is closed"));
    }
    const pending = tail.then(operation);
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
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
