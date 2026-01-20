import type { loadConfig } from "../config/config.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency("cron", cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency("main", resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency("subagent", resolveSubagentMaxConcurrent(cfg));
}
