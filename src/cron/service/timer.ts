import { onTimer } from "./timer-scheduler.js";

export { armTimer, stopTimer } from "./timer-scheduler.js";
export { runMissedJobs } from "./timer-catchup.js";

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronTimerTestApi")] = {
    onTimer,
  };
}
