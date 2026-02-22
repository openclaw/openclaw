export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
  Nested = "nested",
}

/** Prefix for per-conversation lanes — used by lane creation and idle eviction. */
export const CONV_LANE_PREFIX = "conv:";
