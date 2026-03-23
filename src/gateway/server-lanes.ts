import {
  resolveAgentLane,
  resolveAgentLaneConcurrency,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));

  // Apply per-agent custom lane concurrency caps.
  if (cfg.agents?.list) {
    for (const entry of cfg.agents.list) {
      const lane = resolveAgentLane(cfg, entry.id);
      const cap = resolveAgentLaneConcurrency(cfg, entry.id);
      if (lane && cap) {
        setCommandLaneConcurrency(lane, cap);
      } else if (lane) {
        // Custom lane without explicit cap: use the global agent default.
        setCommandLaneConcurrency(lane, resolveAgentMaxConcurrent(cfg));
      }
    }
  }
}
