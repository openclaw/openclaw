/**
 * Local CLI heartbeat status projection (no Gateway RPC).
 * Used by `openclaw system heartbeat status`.
 *
 * Reads canonical Automation jobs via readHeartbeatSummarySnapshot /
 * projectHeartbeatSummary (setup/Doctor proactive monitors). Legacy
 * agents.defaults.heartbeat is retired and is not consulted.
 * Agent selection uses the shared owner APIs — never invent agentId="main".
 */
import {
  resolveAmbientOwnerAgentId,
  resolveConfiguredAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronWithinActiveHours } from "../cron/active-hours.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  projectHeartbeatSummary,
  readHeartbeatSummarySnapshot,
} from "./heartbeat-summary-snapshot.js";

export type HeartbeatCliStatus = {
  agentId: string;
  /** Surviving proactive/migrated Automation job id when one is selected. */
  jobId: string | null;
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
  activeHours: {
    start?: string;
    end?: string;
    timezone?: string;
  } | null;
  withinActiveHours: boolean;
  /** ISO timestamp for the next fire estimate; null when disabled or outside the window. */
  nextFireAt: string | null;
  nextFireInMs: number | null;
  /**
   * Local estimate only — not Gateway scheduler authority.
   * `scheduled` uses job.state.nextRunAtMs when present; otherwise a cadence estimate.
   */
  nextFireSource: "disabled" | "outside-active-hours" | "scheduled" | "cadence-estimate";
};

function resolveAgentIdForStatus(cfg: OpenClawConfig, requested?: string): string {
  if (requested !== undefined) {
    return resolveConfiguredAgentId(cfg, normalizeAgentId(requested));
  }
  return resolveAmbientOwnerAgentId(cfg, undefined, {
    surface: "system heartbeat status",
    hint: "Pass --agent <id>.",
  });
}

function selectJobForAgent(jobs: readonly CronJob[], agentId: string): CronJob | undefined {
  // Receipts list the primary job first; retain it when siblings share an agent.
  return jobs.find((job) => job.agentId === agentId);
}

function projectActiveHours(job?: CronJob): HeartbeatCliStatus["activeHours"] {
  const active = job?.activeHours;
  if (!active) {
    return null;
  }
  return {
    ...(active.start !== undefined ? { start: active.start } : {}),
    ...(active.end !== undefined ? { end: active.end } : {}),
    ...(active.timezone !== undefined ? { timezone: active.timezone } : {}),
  };
}

export async function resolveHeartbeatCliStatus(
  cfg: OpenClawConfig,
  opts: { agentId?: string; nowMs?: number; storePath?: string } = {},
): Promise<HeartbeatCliStatus> {
  const nowMs = opts.nowMs ?? Date.now();
  const resolvedAgentId = resolveAgentIdForStatus(cfg, opts.agentId);
  const jobs = await readHeartbeatSummarySnapshot(cfg, opts.storePath);
  const job = selectJobForAgent(jobs, resolvedAgentId);
  const summary = projectHeartbeatSummary(job);
  const activeHours = projectActiveHours(job);
  const withinActiveHours = isCronWithinActiveHours(
    job?.activeHours ?? undefined,
    nowMs,
    cfg.agents?.defaults?.userTimezone,
  );

  const base: Omit<HeartbeatCliStatus, "nextFireAt" | "nextFireInMs" | "nextFireSource"> = {
    agentId: resolvedAgentId,
    jobId: job?.id ?? null,
    enabled: summary.enabled,
    every: summary.every,
    everyMs: summary.everyMs,
    prompt: summary.prompt,
    target: summary.target,
    model: summary.model,
    session: summary.session,
    ackMaxChars: summary.ackMaxChars,
    activeHours,
    withinActiveHours,
  };

  if (!summary.enabled) {
    return {
      ...base,
      nextFireAt: null,
      nextFireInMs: null,
      nextFireSource: "disabled",
    };
  }
  if (!withinActiveHours) {
    return {
      ...base,
      nextFireAt: null,
      nextFireInMs: null,
      nextFireSource: "outside-active-hours",
    };
  }

  const scheduledAt = job?.state?.nextRunAtMs;
  if (typeof scheduledAt === "number" && Number.isFinite(scheduledAt)) {
    return {
      ...base,
      nextFireAt: new Date(scheduledAt).toISOString(),
      nextFireInMs: Math.max(0, scheduledAt - nowMs),
      nextFireSource: "scheduled",
    };
  }

  const everyMs = summary.everyMs;
  if (everyMs != null && everyMs > 0) {
    return {
      ...base,
      nextFireAt: new Date(nowMs + everyMs).toISOString(),
      nextFireInMs: everyMs,
      nextFireSource: "cadence-estimate",
    };
  }

  return {
    ...base,
    nextFireAt: null,
    nextFireInMs: null,
    nextFireSource: "cadence-estimate",
  };
}
