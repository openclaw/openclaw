import { BroadcastChannel } from "node:worker_threads";
import type { CronServiceState } from "./state.js";

/** Capture the real actor's wake transport while its owner starts. */
export async function captureCronSchedulerWake<T>(
  start: () => Promise<T>,
): Promise<{ result: T; notify: () => void }> {
  let dispatchWake: (() => void) | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    BroadcastChannel.prototype,
    "addEventListener",
  );
  BroadcastChannel.prototype.addEventListener = function (
    this: BroadcastChannel,
    ...[type, listener, options]: Parameters<BroadcastChannel["addEventListener"]>
  ) {
    if (type === "message" && this.name.startsWith("openclaw.cron.")) {
      dispatchWake = () => this.dispatchEvent(new MessageEvent("message"));
    }
    EventTarget.prototype.addEventListener.call(this, type, listener, options);
  };
  let result: T;
  try {
    result = await start();
  } finally {
    if (descriptor) {
      Object.defineProperty(BroadcastChannel.prototype, "addEventListener", descriptor);
    } else {
      Reflect.deleteProperty(BroadcastChannel.prototype, "addEventListener");
    }
  }
  const notify = dispatchWake;
  if (!notify) {
    throw new Error("Cron startup did not register its scheduler wake listener");
  }
  return { result, notify };
}

export async function captureCronSchedulerWakeForTest<T>(
  start: () => Promise<T>,
): Promise<{ result: T; wake: (state: CronServiceState) => Promise<void> }> {
  const { result, notify } = await captureCronSchedulerWake(start);
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
