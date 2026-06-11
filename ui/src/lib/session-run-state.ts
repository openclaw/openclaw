// Control UI module implements session run state behavior.
import type { SessionRunStatus } from "../api/types.ts";

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
};

export function isSessionRunActive(state: SessionRunState): boolean {
  // Paused (sessions_yield) sessions are nonterminal: the run ended via yield
  // but a queued continuation is still pending. UI consumers (reconciler,
  // restart-recovery, sessions-list selection) must not treat them like a
  // finished run, otherwise the yield + continuation flow looks like an
  // interrupted/killed run in the UI. Mirrors the gateway-side nonterminal
  // set (running + paused).
  if (state.status === "paused") {
    return true;
  }
  if (state.status && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "running";
}
