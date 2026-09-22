import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { validateDeliveryCanonicalSessionEntry } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  hasCanonicalSessionValidationProjection,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

export type SessionBackingFact = Pick<SessionEntry, "sessionId" | "updatedAt" | "subagentRecovery">;
export type SessionBackingFactsScope = {
  storePath: string;
  sessionKeys: readonly string[];
  env?: NodeJS.ProcessEnv;
};
export type SessionBackingFacts = Array<{ sessionKey: string; entry: SessionBackingFact }>;

/** Preserve listing admission and malformed-row handling while selecting only requested keys. */
export function readSessionBackingFacts(scope: SessionBackingFactsScope): SessionBackingFacts {
  if (scope.sessionKeys.length === 0) {
    return [];
  }
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionBackingFactsInDatabase(database, scope.sessionKeys),
    options,
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return [];
}

export function readSessionBackingFactsInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKeys: readonly string[],
  continuation?: CanonicalSessionReaderContinuation,
): SessionBackingFacts {
  return readWithCanonicalSessionReaderContinuation(database, continuation, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const keys = new Set(sessionKeys);
    const query = selectSessionEntryRows(database, "list").select("updated_at");
    const pending = getNodeSqliteKysely<DB>(database.db)
      .selectFrom("session_canonical_validation_pending")
      .select("session_key");
    // Warm admission permits raw metadata changes. The listing contract still
    // rejects delivery-canonical sibling drift, so include its existing dirty set.
    // Older readers have no dirty set and retain their full validation inventory.
    const rows = executeSqliteQuerySync(
      database.db,
      hasCanonicalSessionValidationProjection(database)
        ? query.where(
            "session_key",
            "in",
            pending.union(
              getNodeSqliteKysely<DB>(database.db)
                .selectFrom("session_nodes")
                .select("session_key")
                .where("session_key", "in", sqliteStringSet(sessionKeys)),
            ),
          )
        : query,
    ).rows;
    const facts: SessionBackingFacts = [];
    for (const row of rows) {
      if (isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(row, "list");
      if (!entry) {
        continue;
      }
      validateDeliveryCanonicalSessionEntry(row.session_key, entry);
      if (!keys.has(row.session_key)) {
        continue;
      }
      facts.push({
        sessionKey: row.session_key,
        entry: {
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt,
          ...(entry.subagentRecovery ? { subagentRecovery: entry.subagentRecovery } : {}),
        },
      });
    }
    return facts;
  });
}
