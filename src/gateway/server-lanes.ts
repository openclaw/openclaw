import {
  resolveAgentMaxConcurrent,
  resolveSessionLaneMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  setCommandLaneConcurrency,
  setSessionLaneMaxConcurrent,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: OpenClawConfig) {
  const cronMaxConcurrentRuns = cfg.cron?.maxConcurrentRuns ?? 1;
  setCommandLaneConcurrency(CommandLane.Cron, cronMaxConcurrentRuns);
  // Cron isolated agent turns remap inner LLM work to this lane.
  setCommandLaneConcurrency(CommandLane.CronNested, cronMaxConcurrentRuns);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
  // Set default concurrency for session lanes (used by Telegram forum topics, etc.)
  const sessionLaneMaxConcurrent = resolveSessionLaneMaxConcurrent(cfg);
  setSessionLaneMaxConcurrent(sessionLaneMaxConcurrent);
}
