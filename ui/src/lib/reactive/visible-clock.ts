import { listen } from "./listener.ts";
import { projectSource } from "./projection.ts";

function createVisibleClock(intervalMs: number) {
  return projectSource(intervalMs, {
    read: () => Date.now(),
    subscribe: (milliseconds, notify) => {
      let timer: ReturnType<typeof globalThis.setInterval> | undefined;
      const stop = () => {
        globalThis.clearInterval(timer);
        timer = undefined;
      };
      const start = () => {
        if (timer !== undefined || document.visibilityState === "hidden") {
          return false;
        }
        timer = globalThis.setInterval(() => {
          if (document.visibilityState !== "hidden") {
            notify();
          }
        }, milliseconds);
        return true;
      };
      const stopVisibility = listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          stop();
        } else if (start()) {
          notify();
        }
      });
      start();
      return () => {
        stopVisibility();
        stop();
      };
    },
    equality: "revision",
  }).read;
}

const clocks = {
  1_000: createVisibleClock(1_000),
  30_000: createVisibleClock(30_000),
  60_000: createVisibleClock(60_000),
};

/** Tracked readers share cadence and release its timer when the last reader leaves. */
export function readVisibleTime(intervalMs: 1_000 | 30_000 | 60_000): number {
  return clocks[intervalMs]();
}
