import type {
  CommittedCompactionAppend,
  PreparedCompactionAppend,
} from "../../agents/sessions/session-compaction-persistence.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { requireTranscriptEventAppendSnapshot } from "./session-accessor.sqlite-transcript-append-result.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readNextTranscriptSeq,
  readTranscriptContextVersionInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  assertLockedTranscriptWriteAllowed,
  resolveTranscriptAppendRefusal,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import { appendTranscriptEventSnapshotSync } from "./session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "./session-accessor.types.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import {
  assertOwnedTranscriptWriteCommit,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

/** Commits one compaction boundary and its session accounting as one SQLite write. */
export function persistCompactionBoundaryWithSessionEntrySync(
  scope: SessionTranscriptRuntimeTarget &
    Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId" | "env">,
  params: {
    prepared: PreparedCompactionAppend;
    transcriptByteCompactionLatch: NonNullable<
      InternalSessionEntry["transcriptByteCompactionLatch"]
    >;
  },
  projection?: Parameters<typeof appendTranscriptEventSnapshotSync>[3],
): CommittedCompactionAppend {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const preparedScope = withOwnedSessionTranscriptWriterFence(params.prepared.scope);
  const preparedTarget = resolveSqliteTranscriptScope(preparedScope);
  if (
    preparedTarget.agentId !== resolved.agentId ||
    preparedTarget.sessionId !== resolved.sessionId ||
    preparedTarget.sessionKey !== resolved.sessionKey ||
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(preparedTarget)) !==
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return runOpenClawAgentWriteTransaction(
    (database) => {
      assertOwnedTranscriptWriteCommit(fencedScope);
      assertOwnedTranscriptWriteCommit(preparedScope);
      if (params.prepared.initializeEntry) {
        if (
          !ensureSessionEntrySync(preparedScope, {
            sessionId: resolved.sessionId,
            updatedAt: Date.now(),
          })
        ) {
          throw new Error("Session transcript header was not persisted");
        }
        getOwnedSessionTranscriptInitialWriter({ sessionTarget: preparedScope })?.assertActive();
      }
      assertLockedTranscriptWriteAllowed(database, resolved, fencedScope);
      assertLockedTranscriptWriteAllowed(database, resolved, preparedScope);
      const event = {
        ...params.prepared.event,
        parentId: resolveTranscriptMessageAppendParent(database, resolved.sessionId, {
          parentId: params.prepared.event.parentId,
          appendIntent: params.prepared.appendIntent,
        }),
      };
      const firstAppendedSeq = readNextTranscriptSeq(database, resolved.sessionId);
      const appended = appendTranscriptEventSnapshotSync(
        preparedScope,
        event,
        { expectedMutationAt: params.prepared.expectedMutationAt },
        projection,
      );
      const committed = requireTranscriptEventAppendSnapshot(
        appended,
        `Session transcript entry was not persisted: ${event.id}`,
      );
      const appendedRows = readTranscriptEventRows(database, resolved.sessionId, {
        afterSeq: firstAppendedSeq - 1,
      });
      if (
        event.type !== "compaction" ||
        appendedRows.length !== 1 ||
        appendedRows[0]?.eventJson !== JSON.stringify(event)
      ) {
        throw new Error("Compaction boundary validation failed");
      }
      assertOwnedTranscriptWriteCommit(fencedScope);
      assertOwnedTranscriptWriteCommit(preparedScope);
      const fresh = readSessionEntryRow(database, resolved.sessionKey)?.entry;
      const refusal = resolveTranscriptAppendRefusal(fresh, resolved, fencedScope);
      if (refusal) {
        throw new SessionTranscriptWriterClaimReboundError(refusal);
      }
      const entry = projectCanonicalSessionEntryShape({
        ...fresh!,
        ...projectCompactionAccountingPatch(fresh!, {
          compactionKind: "context-engine",
          transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
        }),
      });
      writeSessionEntry(database, resolved.sessionKey, entry, {
        previousEntry: fresh,
        canonicalPreviousEntry: fresh,
      });
      return {
        result: event,
        before: committed.before,
        after: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
      };
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.compaction-boundary" },
  );
}
