import { hasRegisteredSessionPendingInputOwner } from "./session-accessor.sqlite-pending-inputs.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import type { PendingInputScope } from "./session-pending-input-store.js";

export type SessionPendingInputInterruption = "orphaned" | "not-orphaned" | "unavailable";

/**
 * Host proof that an accepted input can never run: admission released it as
 * `interrupted` before any transcript commit, and no live owner holds it. The
 * input stays inert; callers may only re-admit its work under a new identity.
 *
 * "not-orphaned" rests only on evidence a concurrent settlement cannot
 * invalidate: another current session, a transcript commit, a consumed or
 * cancelled (terminal) row, or an owner registered now. The snapshot may predate
 * a settlement that completes while it is read, so a queued row without a current
 * owner, a settling owner, a stale projection or a failed read is "unavailable":
 * callers must keep custody and retry rather than treat the identity as owned.
 */
export async function readSessionPendingInputInterruption(
  scope: PendingInputScope,
  idempotencyKey: string,
): Promise<SessionPendingInputInterruption> {
  try {
    const source = await readPendingInputSource(scope, idempotencyKey, false, {
      commitEvidence: true,
    });
    if (!source) {
      return "unavailable";
    }
    const { current, pending: row, committed } = source.snapshot;
    if (!current) {
      return "not-orphaned";
    }
    if (!row) {
      return committed ? "not-orphaned" : "unavailable";
    }
    if (row.idempotency_key !== idempotencyKey) {
      return "unavailable";
    }
    if (row.consumed_event_id != null || row.state === "cancelled") {
      return "not-orphaned";
    }
    if (hasRegisteredSessionPendingInputOwner(source.path, row, { settling: true })) {
      return "unavailable";
    }
    if (hasRegisteredSessionPendingInputOwner(source.path, row)) {
      return "not-orphaned";
    }
    if (row.state !== "interrupted") {
      // Queued without a current owner: its owner may have settled after the snapshot.
      return "unavailable";
    }
    const evidence = source.snapshot.pendingCommit;
    if (!evidence?.transcriptIndexCurrent) {
      return "unavailable";
    }
    if (evidence.committed) {
      return "not-orphaned";
    }
    source.assertCurrent();
    return "orphaned";
  } catch {
    return "unavailable";
  }
}
