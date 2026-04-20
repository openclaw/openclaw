import { createDeferred } from "../plugin-sdk/extension-shared.js";

export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = ["chat.history", "models.list"] as const;

export const STARTUP_GATE_WAIT_MS = 20_000;

export type StartupGateBarrier = {
  open: () => void;
  waitWithTimeout: (timeoutMs: number) => Promise<boolean>;
  isOpen: () => boolean;
};

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
