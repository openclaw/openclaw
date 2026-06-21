// Recovers queued session deliveries after process crashes.
import {
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage } from "./errors.js";
import {
  ackSessionDelivery,
  clearSessionDeliveryRecoveryState,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryPlatformSendAttemptStarted,
  moveSessionDeliveryToFailed,
  type QueuedSessionDelivery,
} from "./session-delivery-queue-storage.js";

// Session delivery recovery replays persisted messages after crashes while
// bounding retry count, backoff, and concurrent drain work.
type SessionDeliveryRecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

// Hooks let the deliver seam signal the send boundary to recovery: it calls
// onSendAttemptStart once the turn is actually about to run (past any pre-send/busy
// gate), and onSendDeferred if that attempt was deferred without running (e.g. the
// session was busy). Recovery uses these to mark/clear the durable recovery_state
// and to decide, on a thrown deliver, whether the turn may have run (refuse) or was
// a pre-send no-op (safe to retry).
export interface SessionDeliveryDeliverHooks {
  onSendAttemptStart: () => Promise<void>;
  onSendDeferred: () => Promise<void>;
}

type DeliverSessionDeliveryFn = (
  entry: QueuedSessionDelivery,
  hooks?: SessionDeliveryDeliverHooks,
) => Promise<void>;

export interface SessionDeliveryRecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface PendingSessionDeliveryDrainDecision {
  match: boolean;
  bypassBackoff?: boolean;
}

const MAX_SESSION_DELIVERY_RETRIES = 5;

const BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
const drainInProgress = new Map<string, boolean>();
const entriesInProgress = new Set<string>();

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function createEmptyRecoverySummary(): SessionDeliveryRecoverySummary {
  return {
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  };
}

function claimRecoveryEntry(entryId: string): boolean {
  if (entriesInProgress.has(entryId)) {
    return false;
  }
  entriesInProgress.add(entryId);
  return true;
}

function releaseRecoveryEntry(entryId: string): void {
  entriesInProgress.delete(entryId);
}

function computeSessionDeliveryBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

function resolveSessionDeliveryMaxRetries(entry: QueuedSessionDelivery): number {
  return entry.maxRetries ?? MAX_SESSION_DELIVERY_RETRIES;
}

function resolveSessionDeliveryRecoveryDeadlineMs(maxRecoveryMs: number | undefined): number {
  const durationMs = resolveNonNegativeIntegerOption(maxRecoveryMs, 60_000);
  if (durationMs <= 0) {
    return resolveDateTimestampMs(Date.now());
  }
  return resolveExpiresAtMsFromDurationMs(durationMs) ?? resolveDateTimestampMs(Date.now());
}

export function isSessionDeliveryEligibleForRetry(
  entry: QueuedSessionDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeSessionDeliveryBackoffMs(entry.retryCount);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const baseAttemptAt =
    typeof entry.lastAttemptAt === "number" && entry.lastAttemptAt > 0
      ? entry.lastAttemptAt
      : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

async function moveSessionDeliveryToFailedSafe(
  id: string,
  stateDir: string | undefined,
): Promise<"moved-to-failed" | "already-gone"> {
  try {
    await moveSessionDeliveryToFailed(id, stateDir);
    return "moved-to-failed";
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return "already-gone";
    }
    throw err;
  }
}

async function drainQueuedEntry(opts: {
  entry: QueuedSessionDelivery;
  deliver: DeliverSessionDeliveryFn;
  stateDir?: string;
  onRecovered?: (entry: QueuedSessionDelivery) => void;
  onFailed?: (entry: QueuedSessionDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone"> {
  const { entry } = opts;

  // An entry recovered while still carrying the send marker was interrupted (crash)
  // after the turn began running but before it acked. The deliver seam persists the
  // marker only once the turn is actually about to run (past the busy/pre-send gate),
  // so its presence on a recovered entry means a non-idempotent turn may have run and
  // its reply may already have been sent. Without an adapter reconciliation capability
  // we cannot confirm, so we refuse a blind replay and fail-safe to failed/, matching
  // the outbound queue's no-reconcile contract. (Tradeoff: a crash in the narrow window
  // after the turn starts but before ack moves the entry to failed/ rather than
  // replaying it — fail-safe over at-least-once for that window.)
  if (entry.recoveryState === "send_attempt_started") {
    const errMsg =
      "session delivery was interrupted after the turn began (send_attempt_started); refusing blind replay without adapter reconciliation";
    opts.onFailed?.(entry, errMsg);
    return moveSessionDeliveryToFailedSafe(entry.id, opts.stateDir);
  }

  // sendAttempted flips true only when the deliver seam reports the turn is actually
  // running (onSendAttemptStart), and back to false if that attempt was deferred
  // without running (onSendDeferred, e.g. the session was busy). It mirrors the durable
  // marker in-process and decides a thrown deliver: turn-may-have-run (refuse) vs a
  // pre-send / busy-deferred / no-op deliver (safe to retry).
  let sendAttempted = false;
  try {
    await opts.deliver(entry, {
      onSendAttemptStart: async () => {
        sendAttempted = true;
        await markSessionDeliveryPlatformSendAttemptStarted(entry.id, opts.stateDir);
      },
      onSendDeferred: async () => {
        sendAttempted = false;
        await clearSessionDeliveryRecoveryState(entry.id, opts.stateDir);
      },
    });
    await ackSessionDelivery(entry.id, opts.stateDir);
    opts.onRecovered?.(entry);
    return "recovered";
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    opts.onFailed?.(entry, errMsg);
    try {
      if (sendAttempted) {
        // The turn began running (and may have done non-idempotent work / sent its
        // reply) before this throw — refuse a blind replay and fail-safe to failed/.
        // The durable marker also persisted, so a crash here is refused on the next
        // recovery by the guard above.
        return await moveSessionDeliveryToFailedSafe(entry.id, opts.stateDir);
      }
      // The turn never started (pre-send / busy-deferred / no-op deliver path): no
      // marker was persisted and nothing ran, so the entry stays retryable
      // (at-least-once preserved for genuine pre-send failures).
      await failSessionDelivery(entry.id, errMsg, opts.stateDir);
      return "failed";
    } catch (failErr) {
      if (getErrnoCode(failErr) === "ENOENT") {
        return "already-gone";
      }
      return "failed";
    }
  }
}

/** Drain matching queued session deliveries with retry/backoff protection. */
export async function drainPendingSessionDeliveries(opts: {
  drainKey: string;
  logLabel: string;
  log: SessionDeliveryRecoveryLogger;
  stateDir?: string;
  deliver: DeliverSessionDeliveryFn;
  selectEntry: (entry: QueuedSessionDelivery, now: number) => PendingSessionDeliveryDrainDecision;
}): Promise<void> {
  if (drainInProgress.get(opts.drainKey)) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
    return;
  }

  drainInProgress.set(opts.drainKey, true);
  try {
    const matchingEntries = (await loadPendingSessionDeliveries(opts.stateDir))
      .filter((entry) => opts.selectEntry(entry, Date.now()).match)
      .toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);

    for (const entry of matchingEntries) {
      if (!claimRecoveryEntry(entry.id)) {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
        continue;
      }

      try {
        const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
        if (!currentEntry) {
          continue;
        }
        const currentDecision = opts.selectEntry(currentEntry, Date.now());
        if (!currentDecision.match) {
          continue;
        }
        if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
          try {
            await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
          } catch (err) {
            if (getErrnoCode(err) !== "ENOENT") {
              throw err;
            }
          }
          opts.log.warn(
            `${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`,
          );
          continue;
        }

        if (!currentDecision.bypassBackoff) {
          const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            continue;
          }
        }

        await drainQueuedEntry({
          entry: currentEntry,
          deliver: opts.deliver,
          stateDir: opts.stateDir,
          onFailed: (failedEntry, errMsg) => {
            opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
          },
        });
      } finally {
        releaseRecoveryEntry(entry.id);
      }
    }
  } finally {
    drainInProgress.delete(opts.drainKey);
  }
}

/** Replay pending session deliveries until the recovery budget is exhausted. */
export async function recoverPendingSessionDeliveries(opts: {
  deliver: DeliverSessionDeliveryFn;
  log: SessionDeliveryRecoveryLogger;
  stateDir?: string;
  maxRecoveryMs?: number;
  maxEnqueuedAt?: number;
}): Promise<SessionDeliveryRecoverySummary> {
  const pending = (await loadPendingSessionDeliveries(opts.stateDir)).filter(
    (entry) => opts.maxEnqueuedAt == null || entry.enqueuedAt <= opts.maxEnqueuedAt,
  );
  if (pending.length === 0) {
    return createEmptyRecoverySummary();
  }

  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const summary = createEmptyRecoverySummary();
  const deadline = resolveSessionDeliveryRecoveryDeadlineMs(opts.maxRecoveryMs);

  for (const entry of pending) {
    if (Date.now() >= deadline) {
      opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
      break;
    }
    if (!claimRecoveryEntry(entry.id)) {
      continue;
    }

    try {
      const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
      if (!currentEntry) {
        continue;
      }
      if (opts.maxEnqueuedAt != null && currentEntry.enqueuedAt > opts.maxEnqueuedAt) {
        continue;
      }
      if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
        summary.skippedMaxRetries += 1;
        try {
          await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
        } catch (err) {
          if (getErrnoCode(err) !== "ENOENT") {
            throw err;
          }
        }
        continue;
      }

      const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
      if (!retryEligibility.eligible) {
        summary.deferredBackoff += 1;
        continue;
      }

      const result = await drainQueuedEntry({
        entry: currentEntry,
        deliver: opts.deliver,
        stateDir: opts.stateDir,
        onRecovered: () => {
          summary.recovered += 1;
        },
        onFailed: (_failedEntry, errMsg) => {
          summary.failed += 1;
          opts.log.warn(`Session delivery retry failed: ${errMsg}`);
        },
      });
      if (result === "recovered") {
        opts.log.info(`Recovered session delivery ${currentEntry.id}`);
      }
    } finally {
      releaseRecoveryEntry(entry.id);
    }
  }

  return summary;
}
