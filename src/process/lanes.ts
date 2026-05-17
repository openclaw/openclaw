/** Named queue lanes for work that must not interleave with the main command stream. */
export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  CronNested = "cron-nested",
  Subagent = "subagent",
  Nested = "nested",
}

/**
 * After this many milliseconds a queued entry is promoted above all standard
 * priorities so low-priority work is never starved indefinitely by a steady
 * stream of higher-priority enqueues.
 */
export const STARVATION_PROMOTION_MS = 30_000;
