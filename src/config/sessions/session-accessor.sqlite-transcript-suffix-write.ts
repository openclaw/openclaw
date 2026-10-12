import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  transcriptWriteScopeIsCurrent,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptSuffixInTransaction } from "./session-accessor.sqlite-transcript-suffix.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Replaces an exact transcript suffix synchronously and rotates its cursor generation. */
export function replaceTranscriptSuffixEventsSync(
  scope: SessionTranscriptWriteScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  prefixLength = 0,
  expectedMutationAt?: number | null,
  captureVersionInTransaction?: (version: SessionTranscriptContextVersion) => void,
  eventsStartAtPersistedPrefix = false,
  retainedCustomDataIds: readonly string[] = [],
  admit?: (stage: "transaction" | "commit") => void,
  projection?: { scheduleProjectionReconcile?: boolean; onProjectionReconcileNeeded?: () => void },
): boolean {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let replaced = false;
  runOpenClawAgentWriteTransaction(
    (database) => {
      admit?.("transaction");
      assertOwnedTranscriptWriteCommit(fencedScope);
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const fresh = readSessionEntryRow(database, resolved.sessionKey);
      if (!transcriptWriteScopeIsCurrent(fresh?.entry, resolved.sessionId, fencedScope)) {
        return;
      }
      replaceSqliteTranscriptSuffixInTransaction(
        database,
        resolved,
        {
          expectedEvents,
          nextEvents,
          persistedPrefixLength: prefixLength,
          expectedMutationAt,
          eventsStartAtPersistedPrefix,
          retainedCustomDataIds,
        },
        projection,
      );
      const committedVersion = readTranscriptContextVersionInTransaction(
        database,
        resolved.sessionId,
      );
      if (
        captureVersionInTransaction &&
        !stageSqliteTransactionState(database.db, {
          stage: () => {},
          rollback: () => {},
          commit: () => captureVersionInTransaction(committedVersion),
        })
      ) {
        throw new Error("Transcript suffix replacement requires committed transaction state");
      }
      admit?.("commit");
      replaced = true;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.transcript.replace-suffix" },
  );
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return replaced;
}
