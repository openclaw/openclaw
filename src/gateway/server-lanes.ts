import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

/** Applies config-derived concurrency limits to the process-wide command lanes. */
export function applyGatewayLaneConcurrency(cfg: OpenClawConfig) {
  const cronMaxConcurrentRuns = resolveCronMaxConcurrentRuns(cfg.cron);
  setCommandLaneConcurrency(CommandLane.Cron, cronMaxConcurrentRuns);
  // Cron isolated agent turns remap inner LLM work here, so this lane must
  // match cron run concurrency instead of the shared Nested lane default.
  setCommandLaneConcurrency(CommandLane.CronNested, cronMaxConcurrentRuns);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
