import { BroadcastChannel } from "node:worker_threads";
import { vi } from "vitest";
import type { CronServiceState } from "./state.js";

/** Capture the real actor's wake transport while its owner starts. */
export async function captureCronSchedulerWakeForTest<T>(
  start: () => Promise<T>,
): Promise<{ result: T; wake: (state: CronServiceState) => Promise<void> }> {
  let dispatchWake: (() => void) | undefined;
  const capture = vi
    .spyOn(BroadcastChannel.prototype, "addEventListener")
    .mockImplementation(function (this: BroadcastChannel, type, listener, options) {
      if (type === "message" && this.name.startsWith("openclaw.cron.")) {
        dispatchWake = () => this.dispatchEvent(new MessageEvent("message"));
      }
      EventTarget.prototype.addEventListener.call(this, type, listener, options);
    });
  let result: T;
  try {
    result = await start();
  } finally {
    capture.mockRestore();
  }
  const notify = dispatchWake;
  if (!notify) {
    throw new Error("Cron startup did not register its scheduler wake listener");
  }
  return {
    result,
    wake(state) {
      const runSchedulerOwned = state.deps.runSchedulerOwned;
      let pending: Promise<unknown> = Promise.resolve();
      state.deps.runSchedulerOwned = (run) => {
        const work = runSchedulerOwned ? runSchedulerOwned(run) : run();
        pending = work;
        return work;
      };
      try {
        // The listener enters runSchedulerOwned synchronously before awaiting admission.
        notify();
      } finally {
        state.deps.runSchedulerOwned = runSchedulerOwned;
      }
      return pending.then(() => {});
    },
  };
}
