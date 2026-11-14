import { flush } from "../../../test-helpers/solid-settle.ts";

/** Settle a new transcript's mount frames and tasks without draining the caller's work.
 * Already queued frames and timers belong to the caller's clock.
 */
export function settleChatMount<T>(mount: () => T): T {
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  const pending = new Map<number, FrameRequestCallback>();
  const tasks = new Map<Parameters<typeof clearTimer>[0], () => void>();
  globalThis.requestAnimationFrame = (callback) => {
    const id = request.call(globalThis, (timestamp) => {
      if (pending.delete(id)) {
        callback(timestamp);
      }
    });
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
    cancel.call(globalThis, id);
  };
  globalThis.setTimeout = Object.assign(
    (...[callback, delay, ...args]: Parameters<typeof setTimer>) => {
      const timer = setTimer(callback, delay, ...args);
      if (delay === 0 && typeof callback === "function") {
        tasks.set(timer, () => callback(...args));
      }
      return timer;
    },
    setTimer,
  );
  globalThis.clearTimeout = (timer) => {
    tasks.delete(timer);
    clearTimer(timer);
  };
  try {
    const view = mount();
    flush();
    for (let frame = 0; frame < 2; frame += 1) {
      const batch = [...pending];
      for (const [id, callback] of batch) {
        if (pending.delete(id)) {
          cancel.call(globalThis, id);
          callback(performance.now());
        }
      }
      flush();
      const queuedTasks = [...tasks];
      for (const [timer, callback] of queuedTasks) {
        if (tasks.delete(timer)) {
          clearTimer(timer);
          callback();
        }
      }
      flush();
    }
    return view;
  } finally {
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
    globalThis.setTimeout = setTimer;
    globalThis.clearTimeout = clearTimer;
  }
}
