import { expect } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

export function expectRejected(
  respond: unknown,
  error: string | Record<string, unknown> = "UNAVAILABLE",
) {
  const shape = typeof error === "string" ? { code: error } : error;
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(shape));
}

export function expectRejectedOnce(respond: unknown, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, expect.objectContaining(error));
}

/** Hold preparation until the test changes authority, then join the chosen outcome. */
export function createRequestGate() {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  return {
    entered: entered.promise,
    release: released.resolve,
    pause: async () => {
      entered.resolve();
      await released.promise;
    },
    during: async (task: Promise<unknown>, inspect: () => void | Promise<void>, settled = task) => {
      try {
        await Promise.race([entered.promise, task]);
        await inspect();
      } finally {
        released.resolve();
        await settled;
      }
    },
    [Symbol.dispose]: released.resolve,
  };
}
