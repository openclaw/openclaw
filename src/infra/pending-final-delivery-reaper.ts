/**
 * Reaper for replies stranded in `pendingFinalDelivery`.
 *
 * When an embedded run completes but its terminal delivery is busy-skipped by
 * the dispatcher (a wedged/late lane), the generated reply is persisted to
 * `pendingFinalDelivery` and is only ever replayed on the next inbound dispatch
 * or a gateway restart. If neither arrives the reply is stranded indefinitely
 * (see #93625). This reaper periodically delivers such a reply directly — no
 * agent re-run — once its owning run is definitively terminal.
 *
 * Two invariants govern the flush (requested by maintainer review on #93625):
 *  1. A reply is flushed only after the owning run is definitively terminal:
 *     a terminal persisted `status` AND no live embedded run for the session.
 *     The in-memory reply-run/lane "active" flag is intentionally NOT trusted
 *     here — a phantom owner left by a no-op recovery keeps it set, which is the
 *     exact failure mode #93625 describes.
 *  2. The flush is idempotent across gateway restarts: `pendingFinalDelivery`
 *     is cleared atomically on success and the send carries the stable
 *     `pendingFinalDeliveryIntentId`, so a restart's resume path (which also
 *     replays `pendingFinalDelivery`) cannot produce a duplicate user message.
 */
import type { SessionEntry } from "../config/sessions/types.js";

/** Persisted run states that mean the owning run can no longer deliver itself. */
const TERMINAL_RUN_STATUSES: ReadonlySet<NonNullable<SessionEntry["status"]>> = new Set([
  "done",
  "failed",
  "killed",
  "timeout",
]);

/** Default grace before reaping, so the normal next-inbound/restart paths win first. */
export const DEFAULT_PENDING_FINAL_DELIVERY_REAP_AGE_MS = 60_000;
/** Cap retries so a permanently-undeliverable route cannot spin every tick. */
export const DEFAULT_PENDING_FINAL_DELIVERY_MAX_ATTEMPTS = 3;

export type StrandedReply = {
  sessionKey: string;
  entry: SessionEntry;
};

export type PendingFinalDeliveryReaperDeps = {
  /** Snapshot of session entries to scan (cloned; safe to read). */
  listEntries: () => readonly StrandedReply[];
  /** True while the real embedded-run handle for this sessionId is still live. */
  isRunActive: (sessionId: string) => boolean;
  /**
   * Deliver the stranded reply directly to its captured route. Implementations
   * must dedupe by `entry.pendingFinalDeliveryIntentId`. Returns true on a
   * confirmed/queued send, false when no route could be resolved.
   */
  deliver: (reply: StrandedReply) => Promise<boolean>;
  /** Atomically clear the `pendingFinalDelivery*` fields after a successful send. */
  clearPending: (reply: StrandedReply) => Promise<void>;
  /** Record a failed attempt (increment count, stamp time/error) without clearing. */
  recordFailedAttempt: (reply: StrandedReply, error: string) => Promise<void>;
  now: () => number;
  log?: { warn: (msg: string) => void; debug?: (msg: string) => void };
  reapAgeMs?: number;
  maxAttempts?: number;
};

export type PendingFinalDeliveryReapResult = {
  scanned: number;
  reaped: number;
  failed: number;
  skipped: number;
};

function isDefinitivelyTerminal(
  entry: SessionEntry,
  isRunActive: (id: string) => boolean,
): boolean {
  // Positive terminal signal: persisted status is terminal...
  if (!entry.status || !TERMINAL_RUN_STATUSES.has(entry.status)) {
    return false;
  }
  // ...and the real run handle is gone. `isRunActive` reads ACTIVE_EMBEDDED_RUNS,
  // not the reply-run/lane flag a phantom owner poisons (#93625).
  return !entry.sessionId || !isRunActive(entry.sessionId);
}

type PendingFinalDeliverySnapshot = Pick<
  SessionEntry,
  | "pendingFinalDelivery"
  | "pendingFinalDeliveryIntentId"
  | "pendingFinalDeliveryText"
  | "pendingFinalDeliveryCreatedAt"
>;

/**
 * True when `current` still holds the exact pending reply captured in `snapshot`.
 * Clearing must be guarded by this: a same-session run can write a *replacement*
 * `pendingFinalDelivery` while the snapshot is in flight, and an unconditional
 * clear-by-key would erase that newer reply. Compares the stable intent id plus
 * text/createdAt so any replacement fails the match and is left intact.
 */
export function pendingFinalDeliverySnapshotMatches(
  current: PendingFinalDeliverySnapshot,
  snapshot: PendingFinalDeliverySnapshot,
): boolean {
  return (
    current.pendingFinalDelivery === true &&
    current.pendingFinalDeliveryIntentId === snapshot.pendingFinalDeliveryIntentId &&
    current.pendingFinalDeliveryText === snapshot.pendingFinalDeliveryText &&
    current.pendingFinalDeliveryCreatedAt === snapshot.pendingFinalDeliveryCreatedAt
  );
}

/**
 * One reaper pass: deliver every definitively-terminal stranded reply once.
 * Pure over its injected deps so the two invariants are tested in isolation.
 */
export async function reapStrandedPendingFinalDeliveries(
  deps: PendingFinalDeliveryReaperDeps,
): Promise<PendingFinalDeliveryReapResult> {
  const reapAgeMs = deps.reapAgeMs ?? DEFAULT_PENDING_FINAL_DELIVERY_REAP_AGE_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_PENDING_FINAL_DELIVERY_MAX_ATTEMPTS;
  const result: PendingFinalDeliveryReapResult = { scanned: 0, reaped: 0, failed: 0, skipped: 0 };

  for (const reply of deps.listEntries()) {
    const { entry } = reply;
    if (entry.pendingFinalDelivery !== true || !entry.pendingFinalDeliveryText) {
      continue;
    }
    result.scanned++;

    // Invariant 1: only flush after the owning run is definitively terminal.
    if (!isDefinitivelyTerminal(entry, deps.isRunActive)) {
      result.skipped++;
      continue;
    }
    // Grace window: let the normal next-inbound/restart replay paths go first.
    const createdAt = entry.pendingFinalDeliveryCreatedAt ?? 0;
    if (deps.now() - createdAt < reapAgeMs) {
      result.skipped++;
      continue;
    }
    if ((entry.pendingFinalDeliveryAttemptCount ?? 0) >= maxAttempts) {
      result.skipped++;
      continue;
    }

    try {
      const delivered = await deps.deliver(reply);
      if (!delivered) {
        result.skipped++;
        continue;
      }
      // Invariant 2: clear atomically once delivered. Combined with intent-id
      // dedupe in `deliver`, a concurrent restart replay cannot double-send.
      await deps.clearPending(reply);
      result.reaped++;
    } catch (err) {
      result.failed++;
      await deps
        .recordFailedAttempt(reply, err instanceof Error ? err.message : String(err))
        .catch(() => {});
      deps.log?.warn(
        `pending-final-delivery reap failed for ${reply.sessionKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}
