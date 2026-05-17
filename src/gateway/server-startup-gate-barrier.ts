// Local one-shot deferred. Inlined (rather than imported from
// plugin-sdk/extension-shared) so this module stays a true leaf with zero
// internal imports — importing the shared barrel here forms a madge import
// cycle (gateway → plugin-sdk barrel → plugins → config → back).
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Maximum time a startup-gated request will wait for post-attach sidecar
// registration before falling back to the retryable UNAVAILABLE response.
// Post-attach typically completes within 8-15s after [gateway] ready; 20s
// leaves headroom without holding a client indefinitely.
export const STARTUP_GATE_WAIT_MS = 20_000;

export type StartupGateBarrier = {
  open: () => void;
  waitWithTimeout: (timeoutMs: number) => Promise<boolean>;
  isOpen: () => boolean;
};

// A one-shot barrier: requests for startup-gated methods await `open()`
// (called once post-attach sidecar registration completes) instead of
// failing fast. This removes the startup race independent of the client UI
// bundle, since an already-open browser tab on a pre-fix bundle has no
// retry-aware logic of its own.
export function createStartupGateBarrier(): StartupGateBarrier {
  const deferred = createDeferred<void>();
  let opened = false;
  return {
    open: () => {
      if (opened) {
        return;
      }
      opened = true;
      deferred.resolve();
    },
    isOpen: () => opened,
    waitWithTimeout: async (timeoutMs) => {
      if (opened) {
        return true;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([deferred.promise.then(() => true as const), timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}
