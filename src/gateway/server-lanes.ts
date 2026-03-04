import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency, setCommandLaneTaskTimeout } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

/** Main lane task timeout: 11 minutes (embedded run 10min + 1min margin). */
const MAIN_LANE_TASK_TIMEOUT_MS = 660_000;

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
  setCommandLaneTaskTimeout(CommandLane.Main, MAIN_LANE_TASK_TIMEOUT_MS);
}
