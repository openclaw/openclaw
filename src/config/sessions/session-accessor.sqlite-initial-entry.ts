import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionAccessScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRowScan } from "./session-accessor.sqlite-entry-read.js";
import {
  parseReadableSqliteSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
/** Lazy session identity creation, including the original admission's first writer claim. */
import type { InitialSessionEntryCommit } from "./session-manager-write-contract.js";
import {
  assertOwnedTranscriptWriteCommit,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** The transaction owns absence and writer-row checks; callers publish only committed facts. */
export function ensureSessionEntryInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ReturnType<typeof resolveSqliteScope>,
  scope: Pick<SessionTranscriptWriteScope, "expectedWriterRunId">,
  entry: SessionEntry,
  initialWriterRunId?: string,
): InitialSessionEntryCommit {
  const snapshot = readSessionEntryRowScan(database, resolved.sessionKey);
  const existing = snapshot?.selected?.entry;
  if (existing) {
    if (initialWriterRunId !== undefined) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return { owned: existing.sessionId === entry.sessionId };
  }
  if (scope.expectedWriterRunId !== undefined && initialWriterRunId === undefined) {
    return { owned: false };
  }
  const previous = new Map<string, SessionEntry>();
  for (const row of snapshot?.rows ?? []) {
    const previousEntry = parseReadableSqliteSessionEntryRow(database, row);
    if (previousEntry) {
      previous.set(row.session_key, previousEntry);
    }
  }
  const persisted = writeSessionEntry(
    database,
    resolved.sessionKey,
    initialWriterRunId !== undefined ? { ...entry, activeWriterRunId: initialWriterRunId } : entry,
    { canonicalPreviousEntry: null },
  );
  // The writer owns this postimage; no second read is needed to certify its own insert.
  const current = new Map(previous).set(resolved.sessionKey, persisted);
  const owned = persisted.sessionId === entry.sessionId;
  if (initialWriterRunId !== undefined) {
    if (!owned || persisted.activeWriterRunId !== initialWriterRunId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return {
      owned,
      fence: {
        expectedLifecycleRevision: persisted.lifecycleRevision,
        expectedWriterRunId: persisted.activeWriterRunId,
      },
      identity: { previous, current },
    };
  }
  return { owned, identity: { previous, current } };
}

/** Creates a missing session identity without replacing a concurrently owned row. */
export function ensureSessionEntrySync(
  scope: SessionAccessScope &
    Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">,
  entry: SessionEntry,
): boolean {
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionTarget: { ...scope, sessionId: entry.sessionId },
  });
  const initializing = initialWriter && !initialWriter.committedFence;
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteScope(fencedScope);
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  let owned = false;
  const publishCommitted = runOpenClawAgentWriteTransaction(
    (database) => {
      assertOwnedTranscriptWriteCommit({ ...fencedScope, sessionId: entry.sessionId });
      const committed = ensureSessionEntryInTransaction(
        database,
        resolved,
        fencedScope,
        entry,
        initializing ? initialWriter.writerRunId : undefined,
      );
      owned = committed.owned;
      if (!committed.identity) {
        return undefined;
      }
      const publish = prepareSessionIdentityPublication(
        database,
        resolved.agentId,
        committed.identity.previous,
        committed.identity.current,
      );
      if (initializing && committed.fence) {
        const fence = committed.fence;
        // Savepoint success is not COMMIT. The existing transaction owner discards this on rollback.
        if (
          !deferOpenClawAgentPostCommitPublication(database, () => {
            try {
              initialWriter.recordCommitted(fence);
            } finally {
              publish();
            }
          })
        ) {
          throw new Error("initial session writer requires a managed commit boundary");
        }
      }
      return publish;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.entry.ensure" },
  );
  if (!initializing) {
    publishCommitted?.();
  }
  if (fencedScope.expectedWriterRunId !== undefined && !owned) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return owned;
}
