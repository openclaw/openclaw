export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  CronNested = "cron-nested",
  Subagent = "subagent",
  Nested = "nested",
}

export const enum CommandPriority {
  Low = 0,
  Normal = 1,
  High = 2,
}

export const STARVATION_PROMOTION_MS = 30_000;
