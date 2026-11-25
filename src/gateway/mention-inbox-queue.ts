import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

/** Mutations are FIFO barriers between concurrent Inbox read waves. */
export function createMentionInboxQueue(params: {
  assertActive: () => void;
  assertCurrent: () => void;
}) {
  const acceptedWork = new AsyncWorkScope();
  let tail: Promise<void> = Promise.resolve();
  let readers: Array<PromiseWithResolvers<void> & { prepare: () => Promise<void> }> | undefined;

  async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    params.assertActive();
    readers = undefined;
    // Accepted work settles after scheduler cancellation, outside the input writer's custody.
    const pending = runInDetachedAsyncContext(() =>
      acceptedWork.track(() =>
        tail.then(() => {
          params.assertCurrent();
          return operation();
        }),
      ),
    );
    // Failed work must not poison later FIFO operations.
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }

  function read(prepareShared: () => Promise<boolean>, prepare: () => Promise<void>) {
    params.assertActive();
    const reader = { ...Promise.withResolvers<void>(), prepare };
    if (readers) {
      readers.push(reader);
    } else {
      const wave = [reader];
      void enqueue(async () => {
        const preparedAll = await prepareShared();
        for (const waiting of wave) {
          try {
            if (!preparedAll) {
              await waiting.prepare();
            }
            waiting.resolve();
          } catch (error) {
            waiting.reject(error);
          }
        }
        // Clear before resolved readers can start another wave from their response callbacks.
        if (readers === wave) {
          readers = undefined;
        }
      }).catch((error: unknown) => {
        if (readers === wave) {
          readers = undefined;
        }
        for (const waiting of wave) {
          waiting.reject(error);
        }
      });
      readers = wave;
    }
    return reader.promise;
  }

  return {
    enqueue,
    read,
    async drain() {
      await tail;
      await acceptedWork.drain();
    },
  };
}
