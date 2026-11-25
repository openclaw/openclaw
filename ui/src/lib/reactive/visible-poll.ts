import { createEffect, createMemo, onCleanup } from "solid-js";
import { listen } from "./listener.ts";

/** A page-owned timer that pauses while hidden and catches up once on return. */
export function useVisiblePoll(
  intervalMs: number,
  tick: () => void,
  options?: { enabled: () => boolean; immediate?: boolean },
) {
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let stopVisibility: (() => void) | undefined;

  const clearTimer = () => {
    globalThis.clearInterval(timer);
    timer = undefined;
  };
  const startTimer = () => {
    if (timer !== undefined || document.visibilityState === "hidden") {
      return false;
    }
    timer = globalThis.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        tick();
      }
    }, intervalMs);
    return true;
  };
  const onVisibilityChange = () => {
    if (!stopVisibility) {
      return;
    }
    if (document.visibilityState === "hidden") {
      clearTimer();
    } else if (startTimer()) {
      tick();
    }
  };
  const stop = () => {
    stopVisibility?.();
    stopVisibility = undefined;
    clearTimer();
  };
  onCleanup(stop);

  const start = () => {
    if (stopVisibility) {
      return false;
    }
    stopVisibility = listen(document, "visibilitychange", onVisibilityChange);
    startTimer();
    return true;
  };
  if (options) {
    createEffect(createMemo(options.enabled), (enabled) => {
      if (enabled) {
        if (start() && options.immediate && document.visibilityState !== "hidden") {
          tick();
        }
      } else {
        stop();
      }
    });
  }
  return { start, stop };
}
