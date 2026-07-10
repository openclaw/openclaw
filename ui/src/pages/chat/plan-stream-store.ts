// Per-session live plan checklist, captured from the update_plan tool stream (stream:plan).
//
// handleAgentEvent writes the latest checklist here; the chat composer reads it when mounting the
// plan panel. Coalescing/throttling is inherited from the existing tool-stream sync cadence — this
// store only holds last-write-wins state, so rapid deltas never queue up.
import type { PlanChecklist } from "../../lib/plan-checklist.ts";

const planChecklistBySession = new Map<string, PlanChecklist>();

/** Records the latest plan checklist for a session (last-write-wins). */
export function setPlanChecklist(sessionKey: string | undefined, checklist: PlanChecklist): void {
  if (!sessionKey) {
    return;
  }
  planChecklistBySession.set(sessionKey, checklist);
}

/** Returns the latest plan checklist for a session, or null when none has streamed yet. */
export function getPlanChecklist(sessionKey: string | undefined): PlanChecklist | null {
  if (!sessionKey) {
    return null;
  }
  return planChecklistBySession.get(sessionKey) ?? null;
}

/** Drops the checklist for a session (on run reset / new session). */
export function clearPlanChecklist(sessionKey: string | undefined): void {
  if (!sessionKey) {
    return;
  }
  planChecklistBySession.delete(sessionKey);
}

/** Test-only: clears all stored checklists. */
export function resetPlanChecklistStoreForTest(): void {
  planChecklistBySession.clear();
}
