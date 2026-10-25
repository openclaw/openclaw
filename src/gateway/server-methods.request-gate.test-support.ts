import { expect } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";

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
  const { entered, release, wait: pause } = createEnteredGate();
  return {
    entered,
    release,
    pause,
    during: async (task: Promise<unknown>, inspect: () => void | Promise<void>, settled = task) => {
      try {
        await Promise.race([entered, task]);
        await inspect();
      } finally {
        release();
        await settled;
      }
    },
    [Symbol.dispose]: release,
  };
}
