import { BroadcastChannel } from "node:worker_threads";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CronServiceState } from "./state.js";

/** Capture the real actor's wake transport while its owner starts. */
export async function captureCronSchedulerWakeForTest<T>(
  start: (wakeRegistered: Promise<void>) => Promise<T>,
): Promise<{ result: T; notify: () => void; wake: (state: CronServiceState) => Promise<void> }> {
  let dispatchWake: (() => void) | undefined;
  const wakeRegistered = createDeferred();
  const capture = vi
    .spyOn(BroadcastChannel.prototype, "addEventListener")
    .mockImplementation(function (this: BroadcastChannel, type, listener, options) {
      if (type === "message" && /^openclaw\.cron\.[^.]+$/u.test(this.name)) {
        dispatchWake = () => this.dispatchEvent(new MessageEvent("message"));
        wakeRegistered.resolve();
      }
      EventTarget.prototype.addEventListener.call(this, type, listener, options);
    });
  let result: T;
  try {
    result = await start(wakeRegistered.promise);
  } finally {
    capture.mockRestore();
  }
  const notify = dispatchWake;
  if (!notify) {
    throw new Error("Cron startup did not register its scheduler wake listener");
  }
  return {
    result,
    notify,
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
