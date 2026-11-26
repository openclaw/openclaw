import { patchSessionEntryCore } from "./session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { resolveSessionWorkStartBlock } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

type EntryScope = Parameters<typeof patchSessionEntryCore>[0];
type NativeRecovery = NonNullable<InternalSessionEntry["nativeRestartRecovery"]>;
type Incarnation = Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">;

function sameIncarnation(entry: Incarnation | undefined, snapshot: Incarnation): boolean {
  return (
    entry?.sessionId === snapshot.sessionId &&
    entry.lifecycleRevision === snapshot.lifecycleRevision
  );
}

function receiptWrite(assertCurrent: () => void) {
  return { requireWriteSuccess: true, skipMaintenance: true, assertCommitAllowed: assertCurrent };
}

/** Record custody before a native writer starts; terminal lifecycle settlement clears it. */
export async function recordNativeRestartRecovery(
  target:
    | (Omit<EntryScope, "sessionKey"> & {
        sessionKey?: string;
        expectedWriterRunId?: string;
        expectedLifecycleRevision?: string;
      })
    | undefined,
  sessionId: string,
  assertCurrent: () => void,
): Promise<boolean> {
  if (!target?.sessionKey || !target.expectedWriterRunId) {
    return true; // Standalone calls without a Gateway writer cannot recover a turn.
  }
  const scope = { ...target, sessionKey: target.sessionKey };
  const writer = {
    sessionId,
    lifecycleRevision: target.expectedLifecycleRevision,
    runId: target.expectedWriterRunId,
  };
  const ownsRun = (entry: InternalSessionEntry) =>
    sameIncarnation(entry, writer) && entry.activeWriterRunId === writer.runId;
  const marked = await patchSessionEntryCore(
    scope,
    (entry) =>
      ownsRun(entry) && entry.nativeRestartRecovery?.state !== "held"
        ? { nativeRestartRecovery: { runId: writer.runId, state: "running" } }
        : null,
    receiptWrite(assertCurrent),
  );
  if (
    marked?.nativeRestartRecovery?.runId !== writer.runId ||
    marked.nativeRestartRecovery.state !== "running"
  ) {
    return false;
  }
  assertCurrent();
  return true;
}

/** Classify only the interrupted run named by the current session entry. */
export function readInterruptedNativeRestartReceipt(
  entry: InternalSessionEntry,
): NativeRecovery | undefined {
  const receipt = entry.nativeRestartRecovery;
  if (
    receipt?.state === "running" &&
    (receipt.runId === entry.activeWriterRunId ||
      receipt.runId === entry.lifecycleRunId ||
      receipt.runId === entry.lastRunId)
  ) {
    return receipt;
  }
  return undefined;
}

/** Use the caller's admitted view and acknowledge only the held receipt it names. */
export async function acknowledgeNativeRestartRecovery(
  scope: EntryScope,
  snapshot: Incarnation,
  view: { sessionId: string; runId: string },
  admitted: { sessionId: string },
  assertCurrent: () => void,
): Promise<"accepted" | "session-mismatch" | "not-held"> {
  if (snapshot.sessionId !== admitted.sessionId || view.sessionId !== admitted.sessionId) {
    return "session-mismatch";
  }
  const updated = await patchSessionEntryCore(
    scope,
    (entry) =>
      sameIncarnation(entry, snapshot) &&
      entry.nativeRestartRecovery?.state === "held" &&
      entry.nativeRestartRecovery.runId === view.runId
        ? { nativeRestartRecovery: { runId: view.runId, state: "releasing" } }
        : null,
    receiptWrite(assertCurrent),
  );
  return updated?.nativeRestartRecovery?.state === "releasing" &&
    updated.nativeRestartRecovery.runId === view.runId
    ? "accepted"
    : "not-held";
}

/** Keep the release bound to its original chat history even after the queue has a live owner. */
export async function canReleaseNativeRestartQueue(
  scope: EntryScope,
  snapshot: Incarnation & { nativeRestartRecovery?: NativeRecovery },
  replayOwned: boolean,
  assertCurrent: () => void,
): Promise<boolean> {
  const current = await readSessionEntryReadOnlyInWorker(scope, assertCurrent);
  if (!current || !sameIncarnation(current, snapshot)) {
    return false;
  }
  const receipt = current.nativeRestartRecovery;
  if (receipt?.state === "held") {
    const blocked = resolveSessionWorkStartBlock(scope.sessionKey, current);
    if (blocked) {
      throw blocked;
    }
    return false;
  }
  return (
    replayOwned ||
    (receipt?.state === "releasing" && receipt.runId === snapshot.nativeRestartRecovery?.runId)
  );
}

export async function finishNativeRestartQueueRelease(
  scope: EntryScope,
  snapshot: Incarnation & { nativeRestartRecovery?: NativeRecovery },
  assertCurrent: () => void,
): Promise<void> {
  await patchSessionEntryCore(
    scope,
    (entry) =>
      sameIncarnation(entry, snapshot) &&
      entry.nativeRestartRecovery?.state === "releasing" &&
      entry.nativeRestartRecovery.runId === snapshot.nativeRestartRecovery?.runId
        ? { nativeRestartRecovery: undefined }
        : null,
    receiptWrite(assertCurrent),
  );
}
