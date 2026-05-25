export const CommandLane = {
  Main: "main",
  Cron: "cron",
  CronNested: "cron-nested",
  Subagent: "subagent",
  Nested: "nested",
} as const;

export type CommandLane = (typeof CommandLane)[keyof typeof CommandLane];
