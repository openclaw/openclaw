import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.types.js";
import { validateDeliveryCanonicalSessionEntry } from "./session-accessor.sqlite-entry-read.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
  hasCanonicalSessionValidationProjection,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

/** Select metadata without hydrating a store snapshot or participant display facts. */
export function readSelectedSessionEntryMetadataInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKeys: readonly string[],
  continuation?: CanonicalSessionReaderContinuation,
): SessionEntrySummary[] {
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
    const entries: SessionEntrySummary[] = [];
    for (const row of rows) {
      if (isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(row, "list");
      if (!entry) {
        continue;
      }
      validateDeliveryCanonicalSessionEntry(row.session_key, entry);
      if (keys.has(row.session_key)) {
        entries.push({ sessionKey: row.session_key, entry });
      }
    }
    return entries;
  });
}

/**
 * Lists session entries without opening the agent database writable.
 * Transient lock errors propagate: only the caller knows whether "empty" is an
 * acceptable degradation (health snapshots) or hides real state (migration detection).
 */
export function listSessionEntriesReadOnly(
  scope: SessionEntryListScope = {},
  options: { deferParticipants?: true } = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => listSqliteSessionEntriesFromDatabase(database, resolved, scope, options),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

export function listSqliteSessionEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedSqliteScope,
  scope: SessionEntryListScope,
  options: { deferParticipants?: true } = {},
): SessionEntrySummary[] {
  if (scope.expiredCronRuns) {
    const { agentId, updatedBefore } = scope.expiredCronRuns;
    const requestedOwner = normalizeAgentId(agentId);
    return withSqlitePostCommitPublications(database.db, () =>
      runSqliteDeferredTransactionSync(database.db, () => {
        const selectedKeys = new Set<string>();
        const snapshot = readSessionEntryCache(database, {
          cache: false,
          retainFullEntry: (sessionKey, entry) => {
            const selected =
              isCronRunSessionKey(sessionKey) &&
              normalizeAgentId(parseAgentSessionKey(sessionKey)!.agentId) === requestedOwner &&
              !((entry.updatedAt ?? 0) >= updatedBefore);
            if (selected) {
              selectedKeys.add(sessionKey);
            }
            return selected;
          },
        });
        // Sibling metadata and participants still cross complete listing validation.
        return Array.from(iterateSessionEntriesForListing(snapshot, false, selectedKeys));
      }),
    );
  }
  const projection = scope.projection ?? "full";
  const cache = !isIncognitoOpenClawAgentSqlitePath(database.path, {
    agentId: database.agentId,
    env: resolved.env,
  });
  const snapshot = readSessionEntryCache(database, {
    cache,
    latest: scope.readConsistency === "latest",
    projection,
    deferParticipants: options.deferParticipants,
  });
  return Array.from(
    iterateSessionEntriesForListing(
      snapshot,
      projection === "list" && scope.clone !== false,
      scope.sessionKeys ? new Set(scope.sessionKeys) : undefined,
    ),
  );
}

/** Applies the listing visibility and canonical-key contract to an owned snapshot. */
export function* iterateSessionEntriesForListing(
  snapshot: SessionEntryCacheSnapshot,
  cloneEntries = false,
  sessionKeys?: ReadonlySet<string>,
): IterableIterator<SessionEntrySummary> {
  for (const sessionKey of snapshot.keys) {
    if (isInternalSessionEffectsKey(sessionKey)) {
      continue;
    }
    const entry = snapshot.entries.get(sessionKey);
    if (!entry) {
      continue;
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry);
    if (deliveryCanonicalKey !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    // Selection cannot hide a non-canonical row elsewhere in the same snapshot.
    if (sessionKeys && !sessionKeys.has(sessionKey)) {
      continue;
    }
    // Full snapshots own their nested values; list snapshots may share cached entries.
    yield {
      sessionKey,
      entry: cloneEntries ? cloneSessionEntry(entry) : entry,
    };
  }
}
