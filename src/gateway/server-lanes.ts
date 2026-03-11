import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  const cronConcurrency = cfg.cron?.maxConcurrentRuns ?? 1;
  setCommandLaneConcurrency(CommandLane.Cron, cronConcurrency);
  // Cron embedded runs execute in the nested lane to avoid re-entering the cron
  // lane (which deadlocks when cron.run itself is enqueued behind that lane).
  // Keep nested concurrency aligned with cron.maxConcurrentRuns so the config
  // remains the effective limit for isolated cron jobs.
  setCommandLaneConcurrency(CommandLane.Nested, cronConcurrency);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
