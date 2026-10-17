import { createDeferredCore } from "../../../shared/deferred.js";

export function createRequestGate(signal?: AbortSignal) {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  const release = () => released.resolve();
  signal?.addEventListener("abort", release, { once: true });
  return {
    entered: entered.promise,
    release,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
    cleanup: () => signal?.removeEventListener("abort", release),
  };
}
