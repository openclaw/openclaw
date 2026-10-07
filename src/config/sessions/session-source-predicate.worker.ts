import { isDeepStrictEqual } from "node:util";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
} from "./session-entry-patch.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function readRefusedSessionSource(
  database: Parameters<typeof readExactSessionEntryRowValidated>[0],
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
  entries?: ReadonlyMap<string, SessionEntry | undefined>,
): SessionEntryPatchCommitted["refusedSource"] {
  for (const [index, source] of (sources ?? []).entries()) {
    if (identity !== source.source.databaseIdentity) {
      return { index, facts: { entry: undefined } };
    }
    const entry = entries?.has(source.sessionKey)
      ? entries.get(source.sessionKey)
      : readExactSessionEntryRowValidated(database, source.sessionKey)?.entry;
    const members =
      source.members === undefined
        ? undefined
        : listSessionMembersInDatabase(database, source.sessionKey).map(
            (member) => member.identityId,
          );
    if (
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      (members !== undefined && !isDeepStrictEqual(members, source.members)) ||
      (source.transcript &&
        !isDeepStrictEqual(
          { ...readTranscriptContextVersionInTransaction(database, source.transcript.sessionId) },
          source.transcript.version,
        ))
    ) {
      return { index, facts: { entry, members } };
    }
  }
  return undefined;
}
