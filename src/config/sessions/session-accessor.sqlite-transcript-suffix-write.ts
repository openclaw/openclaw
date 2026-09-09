import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  transcriptWriteScopeIsCurrent,
} from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptContextVersionInTransaction,
  type SessionTranscriptContextVersion,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "./session-accessor.sqlite-transcript-suffix.js";
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
): boolean {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const owner = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const plan = prepareSqliteTranscriptSuffixMutation(
    owner,
    resolved,
    expectedEvents,
    nextEvents,
    prefixLength,
    expectedMutationAt,
    eventsStartAtPersistedPrefix,
    retainedCustomDataIds,
  );
  let replaced = false;
  runOpenClawAgentWriteTransaction((database) => {
    assertOwnedTranscriptWriteCommit(fencedScope);
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!transcriptWriteScopeIsCurrent(fresh?.entry, resolved.sessionId, fencedScope)) {
      return;
    }
    replaceSqliteTranscriptSuffixInTransaction(database, resolved, plan);
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
    replaced = true;
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return replaced;
}
