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

/** A restartable one-shot owned by the component, for event-driven feedback and debounce. */
export function createTimeout(callback: () => void, milliseconds: number) {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cancel = () => {
    globalThis.clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(cancel);
  return {
    cancel,
    schedule() {
      cancel();
      timer = globalThis.setTimeout(() => {
        timer = undefined;
        callback();
      }, milliseconds);
    },
  };
}
