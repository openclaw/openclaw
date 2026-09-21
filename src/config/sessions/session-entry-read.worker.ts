import { expectDefined } from "@openclaw/normalization-core";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { SessionMetadataUnavailableError } from "../../state/openclaw-agent-db-read-error.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-read.js";
import { readSessionBackingFactsInDatabase } from "./session-backing-facts.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type {
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
} from "./session-transcript-worker.types.js";

/** Full rows share a snapshot with lifecycle fallback; backing reads retain listing admission. */
export function readExactSessionEntriesWithLifecycle(
  request: SessionExactEntriesWorkerInput,
): SessionExactEntriesWorkerResult {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      request.projection === "backing"
        ? {
            kind: "session-exact-entries" as const,
            entries: readSessionBackingFactsInDatabase(
              database,
              request.sessionKeys,
              request.continuation,
            ),
            lifecycleTimestamps: {},
          }
        : withSqlitePostCommitPublications(database.db, () =>
            runSqliteDeferredTransactionSync(database.db, () => {
              assertCanonicalSqliteSessionKeysCurrent(database);
              const selected = expectDefined(
                readExactSessionEntryCandidatesInDatabase(
                  database,
                  [request.sessionKeys],
                  "full",
                )[0],
                "exact session read result",
              );
              if (!selected.ok) {
                throw selected.error;
              }
              const entry = selected.value.find(
                ({ sessionKey }) => sessionKey === request.lifecycleSessionKey,
              )?.entry;
              return {
                kind: "session-exact-entries" as const,
                entries: selected.value,
                lifecycleTimestamps: resolveSessionLifecycleTimestamps({
                  entry,
                  agentId: database.agentId,
                  sessionKey: request.lifecycleSessionKey,
                  readHeader: (sessionId) => readTranscriptHeaderFromDatabase(database, sessionId),
                }),
              };
            }),
          ),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} };
}
