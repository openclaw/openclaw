import type { loadConfig } from "../config/config.js";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
} from "../config/agent-limits.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency("cron", cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(
    "main",
    cfg.agents?.defaults?.maxConcurrent ?? DEFAULT_AGENT_MAX_CONCURRENT,
  );
  setCommandLaneConcurrency(
    "subagent",
    cfg.agents?.defaults?.subagents?.maxConcurrent ?? DEFAULT_SUBAGENT_MAX_CONCURRENT,
  );
}
