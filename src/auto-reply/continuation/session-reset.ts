// Decisions that end continuation custody (RFC docs/design/continue-work-signal-v2.md §5.4.4,
// "Reset at any boundary"): /new and /reset replace the conversational head and keep the
// elections it has not driven yet; delete ends the session and terminalizes all of its custody;
// the owner's explicit cancel ends exactly the records it names.
import { abortContinuationDispatchClaim } from "./continuation-dispatch-claims.js";
import { listContinuationRecords, updateContinuationRecords } from "./custody/custody-store.js";
import type { ContinuationRecord, ContinuationRecordPatch } from "./custody/custody-store.types.js";
import { releaseWorkOperatorContinuation } from "./work-operator-continuation.js";

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
): Promise<void> {
  await terminalizeAtBoundary(sessionKey, assertCurrent, "session");
}

/**
 * Retire the custody a /new or /reset head swap ends: a wake already driving the replaced head's
 * turn and post-compaction shards. Queued wakes and delegates stay for the successor.
 */
export async function retireReplacedHeadContinuations(
  sessionKey: string,
  assertCurrent: () => void,
): Promise<void> {
  await terminalizeAtBoundary(sessionKey, assertCurrent, "head");
}

async function terminalizeAtBoundary(
  sessionKey: string,
  assertCurrent: () => void,
  boundary: SessionContinuationBoundary,
): Promise<void> {
  const now = Date.now();
  const records = await readRecordsForReset(`owned by ${sessionKey}`, () =>
    listContinuationRecords({ ownerSessionKey: sessionKey }),
  );
  for (const initial of records) {
    await terminalizeRecord(
      initial,
      (record) => resetPatch(record, now, boundary),
      // Check at the effect: a replacement that won while this reset awaited keeps
      // its custody. Not atomic with the write: a replacement committing between
      // this check and the worker applying it is still cancelled, and the caller's
      // post-loop check then fails the reset visibly. Accepted race (worker round trip).
      assertCurrent,
      now,
    );
  }
}

/**
 * CAS-applies `patchFor` to one record, re-reading it after a revision conflict, and releases
 * the operator custody of the election it ends. A failed read or write leaves the record as it
 * was and throws the retryable SessionContinuationResetError instead of an unclassified handler
 * error.
 */
async function terminalizeRecord(
  initial: ContinuationRecord,
  patchFor: (record: ContinuationRecord) => ContinuationRecordPatch | undefined,
  assertCurrent: () => void,
  now: number,
): Promise<
  | { applied: true; record: ContinuationRecord; patch: ContinuationRecordPatch }
  | { applied: false; record: ContinuationRecord | undefined }
> {
  let current: ContinuationRecord | undefined = initial;
  for (let attempt = 0; current; attempt += 1) {
    const patch = patchFor(current);
    if (!patch) {
      break;
    }
    assertCurrent();
    let result: Awaited<ReturnType<typeof updateContinuationRecords>>;
    try {
      result = await updateContinuationRecords(
        [
          {
            recordId: current.recordId,
            ownerSessionKey: current.ownerSessionKey,
            expectedRevision: current.revision,
            patch,
          },
        ],
        { now },
      );
    } catch (err) {
      throw new SessionContinuationResetError(
        current.recordId,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (result.outcome === "applied") {
      releaseWorkOperatorContinuation(current.recordId);
      return { applied: true, record: current, patch };
    }
    if (result.outcome === "not_found") {
      return { applied: false, record: undefined };
    }
    if (
      result.outcome !== "revision_conflict" ||
      attempt + 1 >= MAX_SESSION_RESET_CANCELLATION_ATTEMPTS
    ) {
      throw new SessionContinuationResetError(current.recordId, result.outcome);
    }
    const recordId: string = current.recordId;
    current = (
      await readRecordsForReset(recordId, () => listContinuationRecords({ recordIds: [recordId] }))
    )[0];
  }
  return { applied: false, record: current };
}

/** What an explicit cancel did to one named record. */
export type ContinuationCancelOutcome =
  /** A live election ended; its wake or spawn will not run. */
  | "cancelled"
  /** A post-compaction delegate handed to the session queue will not spawn. */
  | "fenced"
  /** Custody already passed to an admitted child run; stop that run with the subagent controls. */
  | "handed-off"
  /** The record had already ended before the cancel. */
  | "already-ended"
  /** This session owns no record with that ID. */
  | "not-found";

export type ContinuationCancelReceiptEntry = {
  recordId: string;
  outcome: ContinuationCancelOutcome;
  kind?: ContinuationRecord["kind"];
  /** The record's status before the cancel. */
  status?: ContinuationRecord["status"];
  childSessionKey?: string;
};

/**
 * The explicit "stop the search": terminalizes exactly the named records the session owns and
 * returns one receipt entry per named ID. Neither /new nor /reset does this implicitly. An admitted
 * child is not stopped here; its entry names the child so the owner can stop it deliberately.
 */
export async function cancelOwnedContinuationRecords(params: {
  ownerSessionKey: string;
  recordIds: readonly string[];
}): Promise<ContinuationCancelReceiptEntry[]> {
  const recordIds = [...new Set(params.recordIds)];
  const now = Date.now();
  const owned = new Map(
    (
      await readRecordsForReset(`owned by ${params.ownerSessionKey}`, () =>
        listContinuationRecords({ ownerSessionKey: params.ownerSessionKey, recordIds }),
      )
    ).map((record) => [record.recordId, record]),
  );
  const receipt: ContinuationCancelReceiptEntry[] = [];
  for (const recordId of recordIds) {
    const initial = owned.get(recordId);
    if (!initial) {
      receipt.push({ recordId, outcome: "not-found" });
      continue;
    }
    const result = await terminalizeRecord(
      initial,
      (record) => cancelPatch(record, now, "Cancelled by owner"),
      () => {},
      now,
    );
    const record = result.record ?? initial;
    const facts = { recordId, kind: record.kind, status: record.status };
    if (result.applied) {
      // The record is terminal or fenced; end the in-process wake or spawn holding its claim.
      abortContinuationDispatchClaim({
        sessionKey: params.ownerSessionKey,
        flowId: recordId,
        reason: "owner-cancel",
      });
      receipt.push({
        ...facts,
        outcome: result.patch.status === "cancelled" ? "cancelled" : "fenced",
      });
      continue;
    }
    if (!result.record) {
      receipt.push({ recordId, outcome: "not-found" });
    } else if (record.handoff && record.cancelRequestedAt === undefined) {
      receipt.push({
        ...facts,
        outcome: "handed-off",
        ...(record.handoff.target === "subagent_runs"
          ? { childSessionKey: record.handoff.childSessionKey }
          : {}),
      });
    } else {
      receipt.push({ ...facts, outcome: "already-ended" });
    }
  }
  return receipt;
}
