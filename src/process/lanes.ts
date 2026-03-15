export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  /** Dedicated lane for manual `cron run` triggers so they don't deadlock with the inner Cron lane. */
  CronManual = "cron-manual",
  Subagent = "subagent",
  Nested = "nested",
}
