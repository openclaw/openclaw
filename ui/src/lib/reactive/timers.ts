import { createEffect, createMemo, onCleanup } from "solid-js";

/** A reactive cadence; undefined pauses it. Equal source refreshes preserve the next tick. */
export function createInterval(callback: () => void, delay: () => number | undefined) {
  createEffect(createMemo(delay), (milliseconds) => {
    if (milliseconds === undefined) {
      return undefined;
    }
    const timer = globalThis.setInterval(callback, milliseconds);
    return () => globalThis.clearInterval(timer);
  });
}

/** A restartable one-shot; a reactive delay arms it automatically, and undefined pauses it. */
export function createTimeout(
  callback: () => void,
  milliseconds: number | (() => number | undefined),
) {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cancel = () => {
    globalThis.clearTimeout(timer);
    timer = undefined;
  };
  const arm = (delay: number) => {
    cancel();
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      callback();
    }, delay);
  };
  if (typeof milliseconds === "function") {
    createEffect(createMemo(milliseconds), (delay) => {
      if (delay !== undefined) {
        arm(delay);
      }
      return cancel;
    });
  }
  onCleanup(cancel);
  return {
    cancel,
    schedule() {
      const delay = typeof milliseconds === "function" ? milliseconds() : milliseconds;
      if (delay === undefined) {
        cancel();
      } else {
        arm(delay);
      }
    },
  };
}
