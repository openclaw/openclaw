import { jsonExtractText, jsonPathValue } from "../../infra/database-engine/json-values.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import { readSelectedSessionEntriesInDatabase } from "./session-accessor.sqlite-entry-selected.read.js";
import { readWithCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
} from "./session-entry-read.types.js";

/** Cleanup selects identity columns before materializing metadata in the same worker snapshot. */
export async function readSessionEntryList(
  request: SessionEntryListWorkerInput,
): Promise<Omit<SessionEntryListWorkerResult, "kind">> {
  const scope = {
    ...request.scope,
    env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
  };
  // Prepare optional command code before entering the synchronous reader snapshot.
  const recovery =
    scope.mainSessionRecovery || scope.pendingExecRecovery || scope.pendingInputRecovery;
  const listing =
    recovery || scope.cleanupSession !== undefined
      ? undefined
      : await import("./session-accessor.sqlite-entry-list.read.js");
  const resolveScope = listing
    ? (await import("./session-accessor.sqlite-read-scope.js")).resolveSqliteScope
    : undefined;
  const mainRecovery = scope.mainSessionRecovery
    ? await import("./restart-recovery-state.js")
    : undefined;
  const cleanup =
    scope.cleanupSession === undefined ? undefined : await import("./plugin-host-cleanup.js");
  let source: SessionEntryListWorkerResult["source"];
  let revision: string | undefined;
  let unchanged: true | undefined;
  let nextCronRunUpdatedAt: number | null = null;
  let nextCronRunSessionKey: string | null = null;
  let nextExecRecoverySessionKey: string | null = null;

  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
        source = captureSessionEntryReadSource(database, request.expectedIdentity);
        if (scope.mainSessionRecovery) {
          const keys = executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
              .selectFrom("session_nodes")
              .select("session_key")
              .where("archived_at", "is", null)
              .where((eb) =>
                eb(
                  jsonPathValue(
                    database.db,
                    eb.ref("entry_json"),
                    eb.val("$.mainRestartRecovery.tombstone"),
                  ),
                  "is",
                  null,
                ),
              )
              .where((eb) =>
                eb.or([
                  ...[
                    "mainRestartRecovery",
                    "restartRecoveryRuns",
                    "restartRecoveryDeliveryRunId",
                    "pendingFinalDelivery",
                  ].map((field) =>
                    eb(jsonExtractText(database.db, eb.ref("entry_json"), field), "is not", null),
                  ),
                  ...(scope.mainSessionRecovery === "orphans"
                    ? [
                        eb(
                          eb.cast<string>(
                            jsonExtractText(database.db, eb.ref("entry_json"), "abortedLastRun"),
                            "text",
                          ),
                          "in",
                          ["1", "true"],
                        ),
                        eb(
                          jsonExtractText(database.db, eb.ref("entry_json"), "status"),
                          "=",
                          "interrupted",
                        ),
                      ]
                    : []),
                ]),
              ),
          ).rows.map((row) => row.session_key);
          // Terminal run fences alone are not custody; completed rows with remaining claims still settle.
          // Startup still validates pending canonical rows even when no orphan needs recovery.
          return keys.length || scope.mainSessionRecovery === "orphans"
            ? readSelectedSessionEntriesInDatabase(database, keys).filter(
                ({ entry, sessionKey }) =>
                  scope.mainSessionRecovery === "orphans"
                    ? mainRecovery!.hasOrphanedMainSessionWork(entry, sessionKey)
                    : mainRecovery!.hasMainSessionRecoveryClaim(entry),
              )
            : [];
        }
        if (scope.pendingExecRecovery) {
          const page = scope.pendingExecRecovery;
          const keys = executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
              .selectFrom("session_nodes")
              .select("session_key")
              .where("session_key", ">", page.afterSessionKey ?? "")
              // Absent facts evaluate to SQL NULL; empty obligations are not candidates.
              .where((eb) =>
                eb(
                  jsonExtractText(database.db, eb.ref("entry_json"), "pendingExecNotifications"),
                  "!=",
                  "{}",
                ),
              )
              .orderBy("session_key")
              .limit(page.limit),
          ).rows.map((row) => row.session_key);
          nextExecRecoverySessionKey = keys.length === page.limit ? keys.at(-1)! : null;
          return keys.length ? readSelectedSessionEntriesInDatabase(database, keys) : [];
        }
        if (scope.pendingInputRecovery) {
          if (!hasSessionPendingInputsSchema(database.db)) {
            return [];
          }
          const keys = executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
              .selectFrom("session_pending_inputs as input")
              .innerJoin("session_nodes as session", (join) =>
                join
                  .onRef("session.session_key", "=", "input.session_key")
                  .onRef("session.current_session_id", "=", "input.session_id"),
              )
              .select("input.session_key")
              .distinct()
              .where("input.consumed_event_id", "is", null)
              // Queued inputs without live custody become interrupted in the history owner.
              .where("input.state", "in", ["queued", "interrupted"])
              .where((eb) =>
                eb.or([
                  eb("input.state", "=", "queued"),
                  ...["sessionSendDelivery", "chatInputRecovery"].map((field) =>
                    eb(
                      jsonPathValue(
                        database.db,
                        eb.ref("input.message_json"),
                        eb.val(`$.__openclaw.${field}`),
                      ),
                      "is not",
                      null,
                    ),
                  ),
                ]),
              ),
          ).rows.map((row) => row.session_key);
          return keys.length ? readSelectedSessionEntriesInDatabase(database, keys) : [];
        }
        if (scope.cleanupSession === undefined) {
          const read = () =>
            listing!.listSqliteSessionEntriesFromDatabase(
              database,
              resolveScope!({ ...scope, sessionKey: "" }),
              scope,
              {
                captureCronRunUpdatedAt: (value) => (nextCronRunUpdatedAt = value),
                captureCronRunSessionKey: (value) => (nextCronRunSessionKey = value),
              },
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
                  current.schemaVersion,
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
        return withSqlitePostCommitPublications(sqlPublicationAnchor(database.db), () =>
          runSqliteReadSnapshotSync(database.db, () => {
            const identities = executeSqliteQuerySync(
              database.db,
              getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
                .selectFrom("session_nodes")
                .select(["session_key as sessionKey", "current_session_id as sessionId"])
                .orderBy("session_key"),
            ).rows;
            const keys = identities
              .filter((row) =>
                cleanup!.matchesPluginHostCleanupSession(row.sessionKey, row, scope.cleanupSession),
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
  return {
    entries: result.found ? result.value : [],
    source,
    revision,
    unchanged,
    ...(scope.expiredCronRuns ? { nextCronRunUpdatedAt } : {}),
    ...(scope.cronRetention ? { nextCronRunSessionKey } : {}),
    ...(scope.pendingExecRecovery ? { nextExecRecoverySessionKey } : {}),
  };
}
