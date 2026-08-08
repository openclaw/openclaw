// Read-only status surface for the maintenance window.
//
// `getMaintenanceStatusReport` is consumed by:
//   * `cron.status` JSON (gateway RPC) — additive diagnostics for operators
//   * the future status CLI command — human-readable snapshot
//   * evidence scripts (see `.artifacts/pr79192-v2-maintenance-proof.mjs`)
//
// It is deliberately small. Anything that mutates state (e.g. drain on
// phase exit) belongs in `maintenance-deferred.ts`. Status here is a pure
// projection of (config, deferred queue, current time).
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMaintenanceDeferralCount, listMaintenanceDeferrals } from "./maintenance-deferred.js";
import { resolveMaintenancePhase } from "./maintenance-policy.js";

export type MaintenanceStatusReport = {
  enabled: boolean;
  phase: "normal" | "maintenance";
  /** When the phase will next change. `null` when maintenance is disabled. */
  nextPhaseChangeMs: number | null;
  /** Configured window in the resolved timezone. `null` when not configured. */
  window: { start: string; end: string; timezone: string } | null;
  /** Roster of agents allowed to run during maintenance. */
  maintenanceAgents: readonly string[];
  /** Whether manual runs may bypass the gate. */
  allowManualRun: boolean;
  /** Total number of currently-deferred jobs in the in-memory queue. */
  deferredCount: number;
  /** Earliest-first backlog snapshot (oldest first). */
  deferredBacklog: ReadonlyArray<{
    jobId: string;
    agentId: string;
    firstDeferredAtMs: number;
    lastDeferredAtMs: number;
    phaseId: string;
  }>;
};

/**
 * Build a status report for a single agent. The phase decision and roster
 * are agent-specific; the deferred backlog is shared.
 */
export function getMaintenanceStatusReportForAgent(params: {
  cfg: OpenClawConfig;
  nowMs: number;
  agentId: string;
}): MaintenanceStatusReport {
  const decision = resolveMaintenancePhase({
    cfg: params.cfg,
    nowMs: params.nowMs,
    agentId: params.agentId,
  });
  const maintenance = params.cfg.cron?.maintenance;
  const windowReport =
    maintenance?.enabled && maintenance.window?.start && maintenance.window.end
      ? {
          start: maintenance.window.start,
          end: maintenance.window.end,
          timezone: maintenance.window.timezone ?? "user",
        }
      : null;
  return {
    enabled: Boolean(maintenance?.enabled),
    phase: decision.phase,
    nextPhaseChangeMs: decision.nextPhaseChangeMs ?? null,
    window: windowReport,
    maintenanceAgents: maintenance?.maintenanceAgents ?? [],
    allowManualRun: Boolean(maintenance?.allowManualRun),
    deferredCount: getMaintenanceDeferralCount(),
    deferredBacklog: listMaintenanceDeferrals().map((entry) => ({
      jobId: entry.jobId,
      agentId: entry.agentId,
      firstDeferredAtMs: entry.firstDeferredAtMs,
      lastDeferredAtMs: entry.lastDeferredAtMs,
      phaseId: entry.phaseId,
    })),
  };
}

/**
 * Convenience wrapper for status read paths that don't care about role
 * isolation (e.g. CLI `cron.status` top-level). Returns the report for a
 * synthetic sentinel agent; the `phase` field is still meaningful because
 * it is window-only and does not depend on the agent id.
 */
export function getMaintenanceStatusReport(params: {
  cfg: OpenClawConfig;
  nowMs: number;
}): MaintenanceStatusReport {
  return getMaintenanceStatusReportForAgent({
    cfg: params.cfg,
    nowMs: params.nowMs,
    agentId: "__status_probe__",
  });
}
