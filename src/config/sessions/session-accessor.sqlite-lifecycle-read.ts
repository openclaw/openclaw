import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { readSessionEntryCount } from "./session-accessor.sqlite-entry-inventory.js";
import { SESSION_LIFECYCLE_WORKER_SELECTED_JSON_BYTES } from "./session-accessor.sqlite-lifecycle-budget.js";
import {
  readSessionEntryLifecyclePlans,
  readSessionEntryLifecycleSnapshot,
  type SessionEntryLifecycleSnapshot,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export type SessionEntryLifecycleReadRequest = (
  | { stage: "snapshot"; params: Parameters<typeof readSessionEntryLifecycleSnapshot>[1] }
  | { stage: "plans"; params: Parameters<typeof readSessionEntryLifecyclePlans>[1] }
  | { stage: "count" }
) & { expectedDatabaseIdentity?: string };

export type SessionEntryLifecycleReadValue = (
  | { stage: "native-required" }
  | { stage: "snapshot"; snapshot: SessionEntryLifecycleSnapshot }
  | { stage: "plans"; deletePlans: SessionStateDeletePlan[] }
  | { stage: "count"; count: number }
) & { databaseIdentity?: string };

function selectedLifecycleRowsFitWorker(
  database: Pick<OpenClawAgentDatabase, "db">,
  params: Parameters<typeof readSessionEntryLifecycleSnapshot>[1],
): boolean {
  const keys = [
    ...params.removals.map((removal) =>
      removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
    ),
    ...params.upsertKeys,
  ];
  const query = getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select((eb) =>
      eb.fn.sum<number>(eb.fn<number>("length", [eb.cast("entry_json", "blob")])).as("bytes"),
    )
    .where("session_key", "in", sqliteStringSet(keys));
  const bytes = executeSqliteQuerySync(database.db, query).rows[0]?.bytes ?? 0;
  return bytes <= SESSION_LIFECYCLE_WORKER_SELECTED_JSON_BYTES;
}

export function readSessionEntryLifecycleInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  request: SessionEntryLifecycleReadRequest,
): SessionEntryLifecycleReadValue {
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  if (
    request.expectedDatabaseIdentity !== undefined &&
    request.expectedDatabaseIdentity !== identity
  ) {
    throw new Error("Session lifecycle read lost its prepared database");
  }
  const databaseIdentity = typeof identity === "string" ? identity : undefined;
  if (request.stage === "snapshot") {
    return {
      stage: request.stage,
      snapshot: readSessionEntryLifecycleSnapshot(database, request.params),
      databaseIdentity,
    };
  }
  if (request.stage === "plans") {
    return {
      stage: request.stage,
      deletePlans: readSessionEntryLifecyclePlans(database, request.params),
      databaseIdentity,
    };
  }
  return { stage: request.stage, count: readSessionEntryCount(database), databaseIdentity };
}

/** Each preparation phase gets its own complete read snapshot; host builders hold no reader. */
export function readSessionEntryLifecycleReadOnly(
  options: OpenClawAgentDatabaseOptions,
  request: SessionEntryLifecycleReadRequest,
): SessionEntryLifecycleReadValue | undefined {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      withSqlitePostCommitPublications(database.db, () =>
        runSqliteDeferredTransactionSync(database.db, (): SessionEntryLifecycleReadValue => {
          if (
            request.stage === "snapshot" &&
            !selectedLifecycleRowsFitWorker(database, request.params)
          ) {
            const identity = readOpenClawAgentDatabaseIdentity(database).identity;
            return {
              stage: "native-required",
              databaseIdentity: typeof identity === "string" ? identity : undefined,
            };
          }
          return readSessionEntryLifecycleInDatabase(database, request);
        }),
      ),
    options,
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new Error(`Session lifecycle read unavailable: ${result.reason}`);
  }
  return undefined;
}
