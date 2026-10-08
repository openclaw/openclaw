import type { DatabaseSync } from "node:sqlite";
import type {
  CommittedCompactionAppend,
  PreparedCompactionAppend,
} from "../../agents/sessions/session-compaction-persistence.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import type {
  SessionTranscriptAccessScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import {
  ensureSessionEntryInTransaction,
  ensureSessionEntrySync,
} from "./session-accessor.sqlite-initial-entry.js";
import {
  assertSqliteTranscriptSnapshotUnchanged,
  readTranscriptEventRows,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { requireTranscriptEventAppendSnapshot } from "./session-accessor.sqlite-transcript-append-result.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readNextTranscriptSeq,
  readTranscriptContextVersionInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  assertLockedTranscriptWriteAllowed,
  resolveTranscriptAppendRefusal,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import { appendTranscriptEventSnapshotSync } from "./session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "./session-accessor.types.js";
import {
  COMPACTION_RUN_USAGE_CLEAR_PATCH,
  projectCompactionAccountingPatch,
} from "./session-entry-projection.js";
import type {
  CompactionBoundaryOperations,
  InitialSessionEntryCommit,
} from "./session-manager-write-contract.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import {
  assertOwnedTranscriptWriteCommit,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

type CompactionScope = SessionTranscriptRuntimeTarget &
  Pick<
    SessionTranscriptWriteScope,
    "env" | "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
  >;
type CompactionParams = {
  prepared: PreparedCompactionAppend;
  transcriptByteCompactionLatch: NonNullable<InternalSessionEntry["transcriptByteCompactionLatch"]>;
};

type CompactionWorkerContext = {
  database: DatabaseSync;
  admit(stage: "transaction" | "commit"): void;
};

/** Commits one compaction boundary and its session accounting as one SQLite write. */
export function persistCompactionBoundaryWithSessionEntrySync(
  scope: CompactionScope,
  params: CompactionParams,
): CommittedCompactionAppend {
  return persistCompactionBoundary(scope, params).committed;
}

/** The metadata worker borrows its canonical connection for the same atomic boundary. */
export function persistCompactionBoundaryWithSessionEntryInWorker(
  scope: CompactionScope,
  params: CompactionParams & { initialWriterRunId?: string },
  context: CompactionWorkerContext,
): CompactionBoundaryOperations["session.transcript.compactionBoundary"]["output"] {
  return persistCompactionBoundary(scope, params, context);
}

function persistCompactionBoundary(
  scope: CompactionScope,
  params: CompactionParams & { initialWriterRunId?: string },
  worker?: CompactionWorkerContext,
): CompactionBoundaryOperations["session.transcript.compactionBoundary"]["output"] {
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
      if (worker && database.db !== worker.database) {
        throw new Error("Session compaction lost its borrowed canonical connection");
      }
      worker?.admit("transaction");
      assertOwnedTranscriptWriteCommit(fencedScope);
      assertOwnedTranscriptWriteCommit(preparedScope);
      let initialEntry: InitialSessionEntryCommit | undefined;
      if (params.prepared.initializeEntry) {
        const entry = { sessionId: resolved.sessionId, updatedAt: Date.now() };
        if (worker) {
          initialEntry = ensureSessionEntryInTransaction(
            database,
            preparedTarget,
            preparedScope,
            entry,
            params.initialWriterRunId,
          );
          if (initialEntry.fence) {
            Object.assign(fencedScope, initialEntry.fence);
            Object.assign(preparedScope, initialEntry.fence);
          }
        }
        if (!(worker ? initialEntry?.owned : ensureSessionEntrySync(preparedScope, entry))) {
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
      let projectionNeedsReconcile = false;
      const appended = appendTranscriptEventSnapshotSync(
        preparedScope,
        event,
        { expectedMutationAt: params.prepared.expectedMutationAt },
        worker
          ? {
              scheduleProjectionReconcile: false,
              onProjectionReconcileNeeded: () => {
                projectionNeedsReconcile = true;
              },
            }
          : undefined,
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
      worker?.admit("commit");
      return {
        committed: {
          result: event,
          before: committed.before,
          after: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
        },
        initialEntry,
        projectionNeedsReconcile,
      };
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.compaction-boundary" },
  );
}

export async function trimTranscriptForManualCompact(
  scope: SessionTranscriptAccessScope,
  selectRetainedLines: (lines: readonly string[]) => readonly string[] | null,
  options: {
    nowMs?: number;
    preparation?: {
      snapshot?: SqliteLifecycleTargetSnapshot;
      assertEntryCurrent: (
        entry: SqliteLifecycleTargetSnapshot[number]["entry"] | undefined,
      ) => void;
      restore: () => Promise<void>;
      assertCurrent: () => void;
      assertCommitCurrent: () => void;
    };
  } = {},
): Promise<{ trimmed: false } | { kept: number; trimmed: true }> {
  const resolved = resolveSqliteTranscriptScope(scope);
  if (options.preparation) {
    options.preparation.assertCurrent();
    await options.preparation.restore();
    options.preparation.assertCurrent();
  } else {
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  }
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      options.preparation?.assertCurrent();
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const snapshotRows = readTranscriptEventRows(database, resolved.sessionId);
      const sessionSnapshot =
        options.preparation?.snapshot ??
        readSessionEntrySelectionSnapshot(database, resolved.sessionKey, true);
      options.preparation?.assertEntryCurrent(sessionSnapshot[0]?.entry);
      const lines = snapshotRows.map((row) => row.eventJson);
      const retainedLines = selectRetainedLines(lines);
      if (!retainedLines) {
        return { trimmed: false };
      }
      if (sessionSnapshot[0]?.entry.sessionId !== resolved.sessionId) {
        throw new Error(
          `Cannot compact SQLite transcript ${resolved.sessionId} without its current session entry`,
        );
      }
      // SAFETY: Retained lines are canonical transcript rows selected by the compaction owner.
      const retainedEvents = retainedLines.map((line) => JSON.parse(line) as TranscriptEvent);
      const publish = runOpenClawAgentWriteTransaction(
        (writeDatabase) => {
          options.preparation?.assertCommitCurrent();
          assertSqliteTranscriptSnapshotUnchanged(writeDatabase, resolved.sessionId, snapshotRows);
          const freshSessionSnapshot = readSessionEntrySelectionSnapshot(
            writeDatabase,
            resolved.sessionKey,
            true,
          );
          assertLifecycleTargetSnapshotUnchanged(
            sessionSnapshot,
            freshSessionSnapshot,
            "session.transcript.manual-compact",
          );
          const freshEntry = freshSessionSnapshot[0]?.entry;
          if (!freshEntry || freshEntry.sessionId !== resolved.sessionId) {
            throw new Error(`SQLite session changed before compacting ${resolved.sessionId}`);
          }
          const identityKeys = collectSessionEntryLookupKeys(resolved.sessionKey);
          const previousIdentity = readSessionIdentitySnapshot(writeDatabase, identityKeys);
          replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, retainedEvents);
          const nextEntry = structuredClone(freshEntry);
          delete nextEntry.contextBudgetStatus;
          Object.assign(nextEntry, COMPACTION_RUN_USAGE_CLEAR_PATCH);
          delete nextEntry.totalTokens;
          delete nextEntry.totalTokensFresh;
          delete nextEntry.totalTokensVersion;
          clearAllCliSessions(nextEntry);
          nextEntry.updatedAt = options.nowMs ?? Date.now();
          // The transcript rewrite, binding clear, and token invalidation describe one generation.
          // Keep them in this transaction so either both become visible or neither does.
          writeSessionEntry(writeDatabase, resolved.sessionKey, nextEntry, {
            previousEntry: freshEntry,
          });
          const currentIdentity = readSessionIdentitySnapshot(writeDatabase, identityKeys);
          options.preparation?.assertCommitCurrent();
          return prepareSessionIdentityPublication(
            writeDatabase,
            resolved.agentId,
            previousIdentity,
            currentIdentity,
          );
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.manual-compact" },
      );
      publish();
      return { kept: retainedLines.length, trimmed: true };
    },
    "session.transcript.compact",
  );
}
