// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export type GatewayLaneConcurrency = {
  cron: number;
  main: number;
  subagent: number;
};

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  return {
    cron: resolveCronMaxConcurrentRuns(cfg.cron),
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(concurrency: GatewayLaneConcurrency): void {
  // Resolution is deliberately separate: this commit-edge applier only updates
  // live queue state and cannot reject a config midway through publication.
  setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  // Cron isolated agent turns remap inner LLM work to this lane.
  setCommandLaneConcurrency(CommandLane.CronNested, concurrency.cron);
  setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
}
