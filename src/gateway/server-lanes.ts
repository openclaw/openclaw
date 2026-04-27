import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: OpenClawConfig) {
  const cronMaxConcurrentRuns = cfg.cron?.maxConcurrentRuns ?? 1;
  setCommandLaneConcurrency(CommandLane.Cron, cronMaxConcurrentRuns);
  // Cron isolated agent turns remap their inner LLM work to the nested lane.
  setCommandLaneConcurrency(CommandLane.Nested, cronMaxConcurrentRuns);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
