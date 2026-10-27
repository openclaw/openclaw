// Native append kernels borrow database ownership; host actor acquisition stays outside.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEvent,
  TranscriptEventAppendResult,
  TranscriptMessageWriteSnapshot,
  TranscriptWriteSnapshot,
  TranscriptEventAppendOptions,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { TranscriptAppendCursor } from "./session-accessor.sqlite-transcript-append.types.js";
import {
  appendTranscriptMessageInTransaction,
  type PreparedTranscriptMessageAppend,
} from "./session-accessor.sqlite-transcript-message-append.js";
import {
  readTranscriptVisibleTailEntryIdInTransaction,
  resolveTranscriptEventAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  assertNonMessageTranscriptEvent,
  assertLockedTranscriptWriteAllowed,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  runTranscriptWriteSnapshotSync,
  type TranscriptWriteViewGuard,
} from "./session-accessor.sqlite-transcript-write-snapshot.js";
import {
  readTranscriptAppendPostimage,
  retainTranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { withOwnedSessionTranscriptWriterFence } from "./transcript-write-context.js";

/** Replaces the active session identity and branch inside the maintenance worker transaction. */
export function replaceSessionWithBranchedTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptWriteScope,
  branch: { sessionId: string; events: TranscriptEvent[] },
  expectedLifecycleRevision: SessionTranscriptWriteScope["expectedLifecycleRevision"],
  assertActive?: () => void,
  projection?: { scheduleProjectionReconcile?: boolean; onProjectionReconcileNeeded?: () => void },
) {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const nextScope = { ...fencedScope, sessionId: branch.sessionId };
  const nextResolved = { ...resolved, sessionId: branch.sessionId };
  const fresh = readSessionEntryRow(database, resolved.sessionKey)?.entry;
  if (
    fresh?.sessionId !== resolved.sessionId ||
    fresh.lifecycleRevision !== expectedLifecycleRevision
  ) {
    const cause = {
      ...(fresh
        ? { actualSessionId: fresh.sessionId, code: "session-rebound" as const }
        : { code: "session-entry-missing" as const }),
      expectedSessionId: resolved.sessionId,
      sessionKey: scope.sessionKey,
    };
    throw new Error(`Branched session was not persisted: ${cause.code}`, { cause });
  }
  assertLockedTranscriptWriteAllowed(database, resolved, fencedScope);
  const identityKeys = collectSessionEntryLookupKeys(resolved.sessionKey);
  const previous = readSessionIdentitySnapshot(database, identityKeys);
  const written = writeSessionEntry(database, resolved.sessionKey, {
    ...projectCanonicalSessionEntryShape({ ...fresh }),
    sessionId: branch.sessionId,
    updatedAt: Date.now(),
  });
  assertLockedTranscriptWriteAllowed(database, nextResolved, nextScope);
  replaceSqliteTranscriptEventsInTransaction(database, nextResolved, branch.events, projection);
  assertActive?.();
  const current = new Map(previous);
  current.set(resolved.sessionKey, written);
  return {
    identity: { previous, current },
    version: readTranscriptContextVersionInTransaction(database, nextResolved.sessionId),
  };
}

export function appendTranscriptEventSnapshotSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
  projection?: {
    scheduleProjectionReconcile: false;
    onProjectionReconcileNeeded: () => void;
    eventJson?: string;
    persistActorMutation?: boolean;
    cursor?: TranscriptAppendCursor;
  },
  view?: TranscriptWriteViewGuard,
  transaction?: OpenClawAgentDatabase,
): Result<TranscriptWriteSnapshot<TranscriptEventAppendResult>, TranscriptAppendRefusal> {
  assertNonMessageTranscriptEvent(event);
  return runTranscriptWriteSnapshotSync<TranscriptEventAppendResult>(
    scope,
    (database, resolved) => {
      const resolvedEvent = resolveTranscriptEventAppendParent(
        database,
        resolved.sessionId,
        event,
        options,
      );
      if (
        appendTranscriptEventInTransaction(
          database,
          resolved,
          resolvedEvent,
          {
            ...projection,
            eventJson: resolvedEvent === event ? projection?.eventJson : undefined,
          },
          projection?.cursor,
        ) === false
      ) {
        return { appended: false };
      }
      if (
        isRecord(resolvedEvent) &&
        "parentId" in resolvedEvent &&
        (resolvedEvent.parentId === null || typeof resolvedEvent.parentId === "string")
      ) {
        return { appended: true, effectiveParentId: resolvedEvent.parentId };
      }
      return { appended: true };
    },
    options.beforeCommitInTransaction,
    options.expectedMutationAt,
    view,
    { eventType: isRecord(event) && typeof event.type === "string" ? event.type : "unknown" },
    transaction,
  );
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Result<TranscriptMessageAppendResult<TMessage> | undefined, TranscriptAppendRefusal> {
  const snapshot = appendTranscriptMessageSnapshotSync(scope, options);
  return snapshot.ok ? ok(snapshot.value.result) : snapshot;
}

export function appendTranscriptMessageSnapshotSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
  preparedMessage?: PreparedTranscriptMessageAppend<TMessage>,
  workerOptions?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  },
  view?: TranscriptWriteViewGuard,
  transaction?: OpenClawAgentDatabase,
): Result<TranscriptMessageWriteSnapshot<TMessage>, TranscriptAppendRefusal> {
  const snapshot = runTranscriptWriteSnapshotSync(
    scope,
    (database, resolved) => {
      const committed = appendTranscriptMessageInTransaction(
        database,
        resolved,
        options,
        preparedMessage,
        workerOptions,
      );
      const result = committed?.result;
      return retainTranscriptAppendPostimage(
        {
          result,
          visibleTailEntryId:
            committed?.visibleTailEntryId ??
            (result
              ? readTranscriptVisibleTailEntryIdInTransaction(
                  database,
                  resolved.sessionId,
                  result.messageId,
                )
              : null),
        },
        readTranscriptAppendPostimage(committed),
      );
    },
    undefined,
    options.expectedMutationAt,
    view,
    {
      eventType: "message",
      messageRole:
        isRecord(options.message) && typeof options.message.role === "string"
          ? options.message.role
          : "unknown",
    },
    transaction,
  );
  if (!snapshot.ok) {
    return snapshot;
  }
  return ok({
    ...snapshot.value,
    result: snapshot.value.result.result,
    visibleTail: {
      entryId: snapshot.value.result.visibleTailEntryId,
      generation: snapshot.value.after.generation,
    },
  });
}
