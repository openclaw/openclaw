import { onCleanup } from "solid-js";

/** A page-owned timer that pauses while hidden and catches up once on return. */
export function useVisiblePoll(intervalMs: number, tick: () => void) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let running = false;

  const clearTimer = () => {
    if (timer !== null) {
      globalThis.clearInterval(timer);
      timer = null;
    }
  };
  const startTimer = () => {
    if (timer !== null || document.visibilityState === "hidden") {
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
    if (!running) {
      return;
    }
    if (document.visibilityState === "hidden") {
      clearTimer();
    } else if (startTimer()) {
      tick();
    }
  };
  const stop = () => {
    running = false;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    clearTimer();
  };
  onCleanup(stop);

  const start = () => {
    if (running) {
      return false;
    }
    running = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
    startTimer();
    return true;
  };
  return { start, stop };
}
