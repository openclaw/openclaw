import type { SessionPostCompactionDelegate } from "../config/sessions.js";

/**
 * Module-level store for `continue_delegate` tool calls.
 *
 * The tool writes pending delegates here during execution. After the agent's
 * response finalizes, `agent-runner.ts` reads and consumes them, feeding them
 * into the same continuation scheduler that bracket-parsed signals use.
 *
 * This is the "tool writes → runner reads" pattern. Precedent:
 * `sessions_spawn` writes to the sub-agent registry during its tool call,
 * and the runner reads completion events later. Same topology.
 *
 * The store is keyed by session key. Multiple delegates per turn are supported
 * (the tool can be called N times in one turn). The runner consumes all pending
 * delegates after the run completes.
 */

export interface PendingContinuationDelegate {
  task: string;
  delayMs?: number;
  silent?: boolean;
  silentWake?: boolean;
}

export interface DelayedContinuationReservation {
  id: string;
  source: "bracket" | "tool";
  task: string;
  createdAt: number;
  fireAt: number;
  generation: number;
  plannedHop: number;
  silent?: boolean;
  silentWake?: boolean;
}

const pendingDelegates = new Map<string, PendingContinuationDelegate[]>();
const delayedReservations = new Map<string, DelayedContinuationReservation[]>();

/**
 * Called by the `continue_delegate` tool during execution.
 * Appends a delegate to the pending list for the session.
 */
export function enqueuePendingDelegate(
  sessionKey: string,
  delegate: PendingContinuationDelegate,
): void {
  const existing = pendingDelegates.get(sessionKey) ?? [];
  existing.push(delegate);
  pendingDelegates.set(sessionKey, existing);
}

/**
 * Called by `agent-runner.ts` after the run completes.
 * Returns and removes all pending delegates for the session.
 * Returns an empty array if none are pending.
 */
export function consumePendingDelegates(sessionKey: string): PendingContinuationDelegate[] {
  const delegates = pendingDelegates.get(sessionKey) ?? [];
  pendingDelegates.delete(sessionKey);
  return delegates;
}

/**
 * Returns the count of pending delegates for a session without consuming them.
 * Used by the tool to report chain position in its return value.
 */
export function pendingDelegateCount(sessionKey: string): number {
  return pendingDelegates.get(sessionKey)?.length ?? 0;
}

export function addDelayedContinuationReservation(
  sessionKey: string,
  reservation: DelayedContinuationReservation,
): void {
  const existing = delayedReservations.get(sessionKey) ?? [];
  existing.push(reservation);
  delayedReservations.set(sessionKey, existing);
}

export function listDelayedContinuationReservations(
  sessionKey: string,
): DelayedContinuationReservation[] {
  return [...(delayedReservations.get(sessionKey) ?? [])];
}

export function delayedContinuationReservationCount(sessionKey: string): number {
  return delayedReservations.get(sessionKey)?.length ?? 0;
}

export function highestDelayedContinuationReservationHop(sessionKey: string): number {
  const reservations = delayedReservations.get(sessionKey);
  if (!reservations || reservations.length === 0) {
    return 0;
  }
  let highestHop = 0;
  for (const reservation of reservations) {
    if (reservation.plannedHop > highestHop) {
      highestHop = reservation.plannedHop;
    }
  }
  return highestHop;
}

export function takeDelayedContinuationReservation(
  sessionKey: string,
  reservationId: string,
): DelayedContinuationReservation | undefined {
  const existing = delayedReservations.get(sessionKey);
  if (!existing || existing.length === 0) {
    return undefined;
  }
  const idx = existing.findIndex((reservation) => reservation.id === reservationId);
  if (idx < 0) {
    return undefined;
  }
  const [removed] = existing.splice(idx, 1);
  if (existing.length === 0) {
    delayedReservations.delete(sessionKey);
  }
  return removed;
}

export function removeDelayedContinuationReservation(
  sessionKey: string,
  reservationId: string,
): boolean {
  return takeDelayedContinuationReservation(sessionKey, reservationId) !== undefined;
}

export function clearDelayedContinuationReservations(sessionKey: string): void {
  delayedReservations.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Post-compaction delegate staging
//
// `post-compaction` delegates stay turn-local until the run succeeds. If the
// same run compacts, agent-runner dispatches them immediately. Otherwise the
// successful run persists them onto SessionEntry for a later compaction cycle.
// Failed turns simply drop this staged state in finally.
// ---------------------------------------------------------------------------

const stagedPostCompactionDelegates = new Map<string, SessionPostCompactionDelegate[]>();

export function stagePostCompactionDelegate(
  sessionKey: string,
  delegate: SessionPostCompactionDelegate,
): void {
  const existing = stagedPostCompactionDelegates.get(sessionKey) ?? [];
  existing.push(delegate);
  stagedPostCompactionDelegates.set(sessionKey, existing);
}

export function consumeStagedPostCompactionDelegates(
  sessionKey: string,
): SessionPostCompactionDelegate[] {
  const delegates = stagedPostCompactionDelegates.get(sessionKey) ?? [];
  stagedPostCompactionDelegates.delete(sessionKey);
  return delegates;
}

export function stagedPostCompactionDelegateCount(sessionKey: string): number {
  return stagedPostCompactionDelegates.get(sessionKey)?.length ?? 0;
}
