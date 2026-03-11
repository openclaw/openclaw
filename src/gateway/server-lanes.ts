import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  const cronConcurrency = cfg.cron?.maxConcurrentRuns ?? 1;
  setCommandLaneConcurrency(CommandLane.Cron, cronConcurrency);
  // Cron embedded runs use a dedicated cron-nested lane so scheduled jobs can
  // honor cron.maxConcurrentRuns without widening interactive nested-agent
  // throughput.
  setCommandLaneConcurrency(CommandLane.CronNested, cronConcurrency);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
