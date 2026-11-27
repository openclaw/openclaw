import { nextSessionSnoozeWakeAt } from "../sessions/session-snooze.ts";
import { createTimeout } from "./timers.ts";

/** A mounted roster owns one wake timer, independent of other surfaces or pagination. */
export function createSessionSnoozeWake(invalidate: () => void) {
  let armed: number | null = null;
  const timer = createTimeout(() => {
    armed = null;
    invalidate();
  });
  return (rows: Parameters<typeof nextSessionSnoozeWakeAt>[0], now = Date.now()) => {
    const next = nextSessionSnoozeWakeAt(rows, now);
    if (next === armed) {
      return;
    }
    armed = next;
    if (next === null) {
      timer.cancel();
    } else {
      timer.schedule(Math.min(2_147_483_647, Math.max(0, next - Date.now() + 1)));
    }
  };
}
