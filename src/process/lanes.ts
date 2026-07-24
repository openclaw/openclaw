/** Named queue lanes for work that must not interleave with the main command stream. */
export const enum CommandLane {
  Main = "main",
  SystemAgent = "system-agent",
  Cron = "cron",
  CronNested = "cron-nested",
  SkillWorkshopReview = "skill-workshop-review",
  Subagent = "subagent",
  Nested = "nested",
}

/**
 * After this many milliseconds a queued entry may promote by one priority tier
 * (capped strictly below foreground) so lower-priority work is not starved
 * indefinitely by a steady stream of same-or-lower-tier enqueues.
 */
export const STARVATION_PROMOTION_MS = 30_000;
