// These synchronous callers deliberately use the existing writable admission owner.
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-read-scope.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Reads one active message identity from the authoritative SQLite projection. */
export function readActiveTranscriptEntryAnchor(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): TranscriptEntryAnchor | undefined {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readActiveTranscriptEntryAnchorInTransaction({
    database,
    resolved,
    entryId: params.entryId,
  });
}

/** Reads only the current transcript mutation fence without parsing transcript rows. */
export function readTranscriptMutationAtSync(scope: SessionTranscriptReadScope): number | null {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt;
}
