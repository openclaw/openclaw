import { createDeferredCore } from "../../../shared/deferred.js";

export function createRequestGate(signal?: AbortSignal) {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  const release = () => released.resolve();
  const cleanup = () => signal?.removeEventListener("abort", release);
  signal?.addEventListener("abort", release, { once: true });
  return {
    entered: entered.promise,
    release,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
    during: async (task: Promise<unknown>, inspect: () => void | Promise<void>, settled = task) => {
      try {
        await Promise.race([
          entered.promise,
          task.then(() => {
            throw new Error("request settled before reaching its gate");
          }),
        ]);
        await inspect();
      } finally {
        release();
        await settled;
        cleanup();
      }
    },
  };
}
