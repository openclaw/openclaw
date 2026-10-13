import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteReadSnapshotSync,
} from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { matchesPluginHostCleanupSession } from "./plugin-host-cleanup.js";
import {
  listSqliteSessionEntriesFromDatabase,
  readSelectedSessionEntriesInDatabase,
} from "./session-accessor.sqlite-entry-list.read.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { readWithCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
} from "./session-entry-read.types.js";

/** Cleanup selects identity columns before materializing metadata in the same worker snapshot. */
export function readSessionEntryList(
  request: SessionEntryListWorkerInput,
): Omit<SessionEntryListWorkerResult, "kind"> {
  const scope = {
    ...request.scope,
    env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
  };
  let source: SessionEntryListWorkerResult["source"];
  let revision: string | undefined;
  let unchanged: true | undefined;

  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
        source = captureSessionEntryReadSource(database, request.expectedIdentity);
        if (scope.cleanupSession === undefined) {
          const read = () =>
            listSqliteSessionEntriesFromDatabase(
              database,
              resolveSqliteScope({ ...scope, sessionKey: "" }),
              scope,
            );
          if (
            scope.projection !== "list" ||
            scope.includeParticipants !== false ||
            scope.sessionKeys !== undefined ||
            scope.cronRetention ||
            scope.expiredCronRuns ||
            scope.readConsistency === "latest" ||
            database.db.isTransaction
          ) {
            return read();
          }
          const current = readSessionEntryCacheValidityToken(database.db);
          const token =
            current.siblingWriteRevision === undefined
              ? undefined
              : JSON.stringify([
                  readOpenClawAgentDatabaseIdentity(database).incarnation,
                  current.siblingWriteRevision,
                  current.sessionNodesGeneration,
                ]);
          if (token !== undefined && request.ifRevision === token) {
            revision = token;
            unchanged = true;
            return [];
          }
          const entries = runSqliteReadSnapshotSync(database.db, read);
          // Publish a committed revision only when the read crossed no writer receipt.
          if (cacheValidityTokensEqual(current, readSessionEntryCacheValidityToken(database.db))) {
            revision = token;
          }
          return entries;
        }
        return withSqlitePostCommitPublications(database.db, () =>
          runSqliteDeferredTransactionSync(database.db, () => {
            const identities = executeSqliteQuerySync(
              database.db,
              getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
                .selectFrom("session_nodes")
                .select(["session_key as sessionKey", "current_session_id as sessionId"])
                .orderBy("session_key"),
            ).rows;
            const keys = identities
              .filter((row) =>
                matchesPluginHostCleanupSession(row.sessionKey, row, scope.cleanupSession),
              )
              .map((row) => row.sessionKey);
            const entries = new Map(
              readSelectedSessionEntriesInDatabase(database, keys).map((entry) => [
                entry.sessionKey,
                entry,
              ]),
            );
            return keys.flatMap((key) => {
              const entry = entries.get(key);
              return entry ? [entry] : [];
            });
          }),
        );
      }),
    { ...request.database, env: scope.env },
  );
  if (!result.found && request.expectedIdentity?.key.startsWith("file:")) {
    throw new Error("Session listing lost its captured physical owner");
  }
  return { entries: result.found ? result.value : [], source, revision, unchanged };
}
