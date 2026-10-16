import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
import { resolveSessionStorePathForScope } from "./session-store-path.js";

/** Read transcript identities in the existing history worker. */
export async function listSessionTranscriptInstancesInWorker(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
): Promise<SessionTranscriptInstance[]> {
  const storePath = resolveSessionStorePathForScope(scope);
  if (
    isIncognitoOpenClawAgentSqlitePath(storePath, { ...scope, agentId: scope.agentId ?? "main" })
  ) {
    return listSessionTranscriptInstances({ ...scope, storePath }, options);
  }
  const { withSessionStoreReaderInWorker } = await import("./session-entry-read-runtime.js");
  return withSessionStoreReaderInWorker(
    { ...scope, storePath },
    async ({ reader, database, logicalAgentId, continuation }) =>
      reader.readTranscriptInstances({
        scope: { ...scope, storePath: database.path, agentId: logicalAgentId },
        options,
        continuation,
      }),
    { backing: true, dataOnly: true },
  );
}

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
