import type { CronSchedule } from "./types.js";

export const HIGH_FREQUENCY_EVERY_THRESHOLD_MS = 30 * 60 * 1000;

export function isHighFrequencyEverySchedule(
  schedule: CronSchedule | undefined,
): schedule is Extract<CronSchedule, { kind: "every" }> {
  return schedule?.kind === "every" && schedule.everyMs < HIGH_FREQUENCY_EVERY_THRESHOLD_MS;
}

export function getHighFrequencyEveryWarningMessage(): string {
  return "Warning: high-frequency cron schedules (<30m) can accumulate sessions and silently exhaust the agent context window; prefer heartbeat or longer intervals when possible.";
}
