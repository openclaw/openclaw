// Decides what a durable followup-queue snapshot may write and may delete.
//
// The snapshot writer replaces the whole table on every mutation, so two
// questions have to be answered before it runs: which queues are allowed on
// disk at all, and which absent rows this process is actually entitled to
// delete. Both answers are policy rather than serialization, so they live here
// instead of in the persistence codec.
import {
  listFollowupQueueKeys,
  listUnreadableFollowupQueueKeys,
} from "../../../infra/followup-queue-sqlite.js";
import { resolveGlobalSet } from "../../../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import type { PersistedQueueEntry } from "./persist-codec.js";
import type { FollowupQueueState, FollowupRun } from "./types.js";

/**
 * Queue keys this process has taken authority over, either by materializing the
 * queue in memory or by reading its durable row during restore. Snapshot
 * replacement may only delete rows for these keys: until restore completes,
 * every other row still belongs to the previous process and is unreconciled.
 */
const locallyOwnedQueueKeys = resolveGlobalSet<string>(
  Symbol.for("openclaw.followupQueueLocallyOwnedKeys"),
  "close-and-restart",
);

/**
 * Queue keys this process retired for an orderly restart. Retirement completes
 * every queued run's lifecycle here and hands the durable row to the next
 * process's startup recovery, so this process must not read that row back, and
 * must not replace it with work enqueued after the handoff.
 */
const restartRetiredQueueKeys = resolveGlobalSet<string>(
  Symbol.for("openclaw.followupQueueRestartRetiredKeys"),
  "close-and-restart",
);

/** Record that `key` was handed to startup recovery by restart retirement. */
export function markFollowupQueueKeyRestartRetired(key: string): void {
  const cleaned = key.trim();
  if (cleaned) {
    restartRetiredQueueKeys.add(cleaned);
  }
}

/** Whether restart retirement already handed `key` to the next process. */
export function isFollowupQueueKeyRestartRetired(key: string): boolean {
  return restartRetiredQueueKeys.has(key.trim());
}

/** Claim durable delete authority for `key` before its first snapshot write. */
export function markFollowupQueueKeyLocallyOwned(key: string): void {
  const cleaned = key.trim();
  if (cleaned) {
    locallyOwnedQueueKeys.add(cleaned);
  }
}

/** Whether this process has reconciled `key` against its durable row. */
export function isFollowupQueueKeyLocallyOwned(key: string): boolean {
  return locallyOwnedQueueKeys.has(key.trim());
}

/**
 * Hand durable delete authority for `key` back to the next process. Restart
 * retirement uses this so an unrelated queue's later snapshot cannot delete a
 * row that startup recovery is expected to replay.
 */
export function releaseFollowupQueueKeyLocalOwnership(key: string): void {
  locallyOwnedQueueKeys.delete(key.trim());
}

/** For testing only — drop all claimed delete authority between cases. */
export function clearFollowupQueueLocalOwnershipForTest(): void {
  locallyOwnedQueueKeys.clear();
  restartRetiredQueueKeys.clear();
}

function followupQueueRuns(queue: FollowupQueueState): FollowupRun[] {
  return [
    ...queue.items,
    ...queue.inFlight,
    ...queue.summarySources,
    ...queue.summaryElisions.flatMap((elision) => elision.sources),
  ];
}

/**
 * Incognito sessions are process-memory only: the session owner routes their
 * agent database to `:memory:` and `docs/concepts/session.md` promises the
 * content never reaches disk. A durable queue snapshot would bypass that owner,
 * so incognito queues stay in memory and are never restored.
 */
export function isIncognitoFollowupQueue(key: string, queue: FollowupQueueState): boolean {
  if (isIncognitoSessionKey(key)) {
    return true;
  }
  // The queue key falls back to a session id when the route has no session key,
  // so classify by the session key each queued run carries as well.
  return (
    isIncognitoSessionKey(queue.lastRun?.sessionKey) ||
    followupQueueRuns(queue).some((item) => isIncognitoSessionKey(item.run.sessionKey))
  );
}

/** Whether a projected entry still carries recoverable work worth a durable row. */
export function persistedQueueEntryCarriesWork(entry: PersistedQueueEntry): boolean {
  return (
    entry.items.length > 0 ||
    (entry.summarySources ?? []).length > 0 ||
    (entry.summaryElisions ?? []).some((elision) => elision.sources.length > 0) ||
    entry.droppedCount > 0
  );
}

/**
 * Keys that must survive snapshot replacement.
 *
 * Unreadable rows are always retained because this writer cannot reconstruct
 * them. Rows this process has never owned are retained too: queue mutations stay
 * enabled while a failed restore retries, so a snapshot built from memory-only
 * queues would otherwise delete durable work that was never loaded. Rows retired for
 * restart are retained because startup recovery replays them. Incognito keys are
 * never retained, so rows leaked by an older build get cleaned up.
 */
export async function resolveFollowupQueueRetainKeys(): Promise<string[]> {
  const retained = new Set(await listUnreadableFollowupQueueKeys());
  for (const key of await listFollowupQueueKeys()) {
    // Retired rows belong to startup recovery even when a queue materialized
    // again here afterwards and re-claimed delete authority for the key.
    if (!locallyOwnedQueueKeys.has(key) || restartRetiredQueueKeys.has(key)) {
      retained.add(key);
    }
  }
  return [...retained].filter((key) => !isIncognitoSessionKey(key));
}
