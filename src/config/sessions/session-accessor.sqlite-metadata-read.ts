import {
  createSqliteQueryCache,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";

// Cache SQL by native handle, never session facts or native statements.
const transcriptPresenceQuery = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  // Archive and restore move events atomically; both stores must share one statement snapshot.
  // A cold descriptor guarantees a nonempty transcript, even when its archive needs repair.
  return prepareSqliteQueryTakeFirstSync<string, { session_id: string }>(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db
      .selectFrom("transcript_events")
      .select("session_id")
      .where("session_id", "=", sessionId)
      .unionAll(
        db
          .selectFrom("session_transcript_cold_archives")
          .select("session_id")
          .where("session_id", "=", sessionId),
      )
      .limit(1);
  });
});

/** Reads physical transcript presence without decoding events or restoring cold storage. */
export function hasSessionTranscriptEventsSync(scope: SessionTranscriptReadScope): boolean {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return Boolean(transcriptPresenceQuery(database.db)(resolved.sessionId));
}

/** Reads both physical mutation fences from the same session window snapshot. */
export function readTranscriptMutationStateSync(scope: SessionTranscriptReadScope) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readTranscriptMutationStateInTransaction(database, resolved.sessionId);
}

/** Reads only the current transcript mutation fence without parsing transcript rows. */
export function readTranscriptMutationAtSync(scope: SessionTranscriptReadScope): number | null {
  return readTranscriptMutationStateSync(scope).updatedAt;
}
