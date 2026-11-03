// Lifecycle boundaries for continuation custody (RFC docs/design/continue-work-signal-v2.md
// §5.4.4, "Reset at any boundary"): /new and /reset replace the conversational head and keep the
// elections it has not driven yet; delete ends the session and terminalizes all of its custody.
import { listContinuationRecords, updateContinuationRecords } from "./custody/custody-store.js";
import type { ContinuationRecord, ContinuationRecordPatch } from "./custody/custody-store.types.js";

const MAX_SESSION_RESET_CANCELLATION_ATTEMPTS = 8;

export class SessionContinuationResetError extends Error {
  constructor(recordId: string, reason: string) {
    super(`Session reset could not cancel continuation record ${recordId}: ${reason}. Retry.`);
    this.name = "SessionContinuationResetError";
  }
}

/**
 * A post-compaction record handed off to the session queue whose child was
 * not accepted yet. Handoffs are permanent, so reset fences the record; the
 * queue drain refuses to spawn a fenced source.
 */
function isUnacceptedPostCompactionHandoff(record: ContinuationRecord): boolean {
  return (
    record.kind === "post_compaction" &&
    record.status === "succeeded" &&
    record.handoff?.target === "session_delivery_queue" &&
    record.cancelRequestedAt === undefined &&
    !stateHasAcceptedChild(record)
  );
}

function stateHasAcceptedChild(record: ContinuationRecord): boolean {
  try {
    const state: unknown = JSON.parse(record.stateJson);
    return (
      typeof state === "object" &&
      state !== null &&
      // SAFETY: state is a non-null object; only its `childSessionKey` property is read.
      typeof (state as { childSessionKey?: unknown }).childSessionKey === "string"
    );
  } catch {
    return false;
  }
}

/** What a lifecycle boundary ends: the conversational head (/new, /reset) or the session (delete). */
type SessionContinuationBoundary = "head" | "session";

/**
 * Elections no head has driven yet outlive a head swap: a queued continue_work wake, and a
 * delegate queued or claimed. A claimed delegate's spawn still resolves at most once (requeued
 * before dispatch, handed off, or interrupted). A wake already driving a turn belongs to the
 * replaced head, and a post-compaction shard needs a rebind rule before it may outlive the
 * context that staged it.
 */
function survivesHeadSwap(record: ContinuationRecord): boolean {
  return record.kind === "delegate" || (record.kind === "work" && record.status === "queued");
}

function cancelPatch(
  record: ContinuationRecord,
  now: number,
  phase: string,
): ContinuationRecordPatch | undefined {
  if (record.status === "queued" || record.status === "running") {
    // Cancel is terminal: the same commit scrubs the attachment reference and
    // the store releases the payload file right after it (§5.4.9 item 6).
    return { status: "cancelled", phase, cancelRequestedAt: now };
  }
  return isUnacceptedPostCompactionHandoff(record) ? { cancelRequestedAt: now } : undefined;
}

function resetPatch(
  record: ContinuationRecord,
  now: number,
  boundary: SessionContinuationBoundary,
): ContinuationRecordPatch | undefined {
  if (boundary === "head" && survivesHeadSwap(record)) {
    return undefined;
  }
  return cancelPatch(record, now, "Cancelled by session reset");
}

/**
 * A failed custody read leaves the records as unretired as a failed write, so
 * the reset fails retryably instead of warning past it and clearing nothing.
 */
async function readRecordsForReset(
  subject: string,
  read: () => Promise<ContinuationRecord[]>,
): Promise<ContinuationRecord[]> {
  try {
    return await read();
  } catch (err) {
    throw new SessionContinuationResetError(
      subject,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Terminalize all durable continuation work owned by a session that ends (delete).
 * `assertCurrent` is the boundary's incarnation fence; it throws once a newer
 * incarnation owns the session.
 */
export async function cancelSessionContinuations(
  sessionKey: string,
  assertCurrent: () => void,
): Promise<string[]> {
  return await terminalizeAtBoundary(sessionKey, assertCurrent, "session");
}

/**
 * Retire the custody a /new or /reset head swap ends: a wake already driving the replaced head's
 * turn and post-compaction shards. Queued wakes and delegates stay for the successor. Returns the
 * record IDs it retired.
 */
export async function retireReplacedHeadContinuations(
  sessionKey: string,
  assertCurrent: () => void,
): Promise<string[]> {
  return await terminalizeAtBoundary(sessionKey, assertCurrent, "head");
}

async function terminalizeAtBoundary(
  sessionKey: string,
  assertCurrent: () => void,
  boundary: SessionContinuationBoundary,
): Promise<string[]> {
  const retired: string[] = [];
  const now = Date.now();
  const records = await readRecordsForReset(`owned by ${sessionKey}`, () =>
    listContinuationRecords({ ownerSessionKey: sessionKey }),
  );
  for (const initial of records) {
    let current: ContinuationRecord | undefined = initial;
    for (let attempt = 0; current; attempt += 1) {
      const patch = resetPatch(current, now, boundary);
      if (!patch) {
        break;
      }
      // Check at the effect: a replacement that won while this reset awaited keeps
      // its custody. Not atomic with the write: a replacement committing between
      // this check and the worker applying it is still cancelled, and the caller's
      // post-loop check then fails the reset visibly. Accepted race (worker round trip).
      assertCurrent();
      let result: Awaited<ReturnType<typeof updateContinuationRecords>>;
      try {
        result = await updateContinuationRecords(
          [
            {
              recordId: current.recordId,
              ownerSessionKey: sessionKey,
              expectedRevision: current.revision,
              patch,
            },
          ],
          { now },
        );
      } catch (err) {
        // A failed write leaves the record as it was; report it as the
        // retryable reset failure instead of an unclassified handler error.
        throw new SessionContinuationResetError(
          current.recordId,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (result.outcome === "applied") {
        retired.push(current.recordId);
        break;
      }
      if (result.outcome === "not_found") {
        break;
      }
      if (
        result.outcome !== "revision_conflict" ||
        attempt + 1 >= MAX_SESSION_RESET_CANCELLATION_ATTEMPTS
      ) {
        throw new SessionContinuationResetError(current.recordId, result.outcome);
      }
      const recordId: string = current.recordId;
      current = (
        await readRecordsForReset(recordId, () =>
          listContinuationRecords({ recordIds: [recordId] }),
        )
      )[0];
    }
  }
  return retired;
}
