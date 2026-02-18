import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));

  // ── Priority Preemption: Heartbeat lane ──────────────────────────
  // When `messages.queue.priorityPreemption` is enabled, heartbeat runs
  // are routed to their own dedicated lane instead of sharing the main
  // lane with human messages. This prevents a 30-60 second heartbeat
  // from blocking a real user who sends a WhatsApp/Telegram message.
  //
  // Concurrency is set to 1 because heartbeats are low-priority
  // background checks — there's no reason to run multiple simultaneously.
  // The lane is always configured (costs nothing if unused).
  setCommandLaneConcurrency(CommandLane.Heartbeat, 1);
}
