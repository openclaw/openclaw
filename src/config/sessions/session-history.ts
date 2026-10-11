import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
} from "./session-accessor.sqlite-contract.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSessionTranscriptInstances(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
  continuation?: CanonicalSessionReaderContinuation,
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, continuation, () => {
        const currentEntries =
          options.sessionId !== undefined || options.sessionIds !== undefined
            ? undefined
            : new Map(
                listSqliteSessionEntriesFromDatabase(database, resolved, {
                  ...scope,
                  clone: false,
                }).map(({ sessionKey, entry }) => [sessionKey, entry]),
              );
        return listTranscriptInstancesFromDatabase({
          currentEntries,
          database,
          options,
          entryProjection: scope.projection,
        });
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

export {
  findSessionTranscriptArchiveEventReadOnly,
  readSessionTaskArchivePageReadOnly,
  verifySessionTranscriptArchivePageBindingReadOnly,
  listSessionTranscriptArchivesReadOnly,
} from "./session-accessor.sqlite-history.js";
