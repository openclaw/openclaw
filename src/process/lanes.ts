/** Named queue lanes for work that must not interleave with the main command stream. */
export const enum CommandLane {
  Main = "main",
  SystemAgent = "system-agent",
  SystemAgentInference = "system-agent-inference",
  Cron = "cron",
  CronNested = "cron-nested",
  /**
   * External hook agent-run dispatch. Distinct from `cron-nested` so hook work
   * is schedulable in its own right; capacity is bounded by the shared lane
   * group rather than by adding a slot outside the cron budget.
   */
  HookDispatch = "hook-dispatch",
  Background = "background",
  RestartRecovery = "restart-recovery",
  Subagent = "subagent",
  ActiveMemory = "active-memory",
  Nested = "nested",
}

export const SUBAGENT_LANE_PREFIX = `${CommandLane.Subagent}:`;
export const SWARM_LANE_PREFIX = `${SUBAGENT_LANE_PREFIX}swarm:`;

/**
 * Per-agent cron lane prefix.
 *
 * Cron inner work used to share one `cron-nested` lane for every agent, so one
 * agent's cron turn could occupy the lane another agent's heartbeat had to
 * observe. Scoping the lane to the owning agent keeps each agent's cron queue
 * separate while the shared cron budget still bounds the total.
 */
export const CRON_NESTED_LANE_PREFIX = `${CommandLane.CronNested}:`;

/** Returns true for a per-agent cron lane such as `cron-nested:main`. */
export function isCronNestedAgentLane(lane: string): boolean {
  return lane.startsWith(CRON_NESTED_LANE_PREFIX);
}

/** Resolves the per-agent cron lane name for an agent id. */
export function resolveCronNestedAgentLane(agentId: string): string {
  return `${CRON_NESTED_LANE_PREFIX}${agentId}`;
}

export type CommandLaneConfiguration = {
  readonly lane: string;
  readonly maxConcurrent: number;
};

// Keep the exported diagnostics inventory closed so per-session lanes cannot
// turn a saturation snapshot into an unbounded payload.
export const STATIC_COMMAND_LANES = [
  CommandLane.Main,
  CommandLane.SystemAgent,
  CommandLane.SystemAgentInference,
  CommandLane.Cron,
  CommandLane.CronNested,
  CommandLane.HookDispatch,
  CommandLane.Background,
  CommandLane.RestartRecovery,
  CommandLane.Subagent,
  CommandLane.ActiveMemory,
  CommandLane.Nested,
] as const;
