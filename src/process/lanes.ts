export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
  Nested = "nested",
  /** Dedicated lane for heartbeat runs so they don't block human messages on Main. */
  Heartbeat = "heartbeat",
}
