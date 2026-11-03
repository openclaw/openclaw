import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.types.js";
import { readSelectedSessionEntriesInDatabase } from "./session-accessor.sqlite-entry-selected.read.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-read-scope.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  canonicalSessionKeyMigrationRequiredError,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

function captureListingSource(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  scope: SessionEntryListScope,
) {
  if (!scope.captureSource) {
    return;
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
  const source = {
    agentId: database.agentId,
    path: database.path,
    databaseIdentity: physical.identity,
    databaseBirthtime: physical.birthtime,
  };
  assertCapturedSessionEntryReadSource(source, database);
  scope.captureSource(() =>
    assertCapturedSessionEntryReadSource(
      source,
      typeof source.databaseIdentity === "symbol" ? database : undefined,
    ),
  );
}

/**
 * Lists session entries without opening the agent database writable.
 * Transient lock errors propagate: only the caller knows whether "empty" is an
 * acceptable degradation (health snapshots) or hides real state (migration detection).
 */
export function listSessionEntriesReadOnly(
  scope: SessionEntryListScope = {},
  options: {
    deferParticipants?: true;
    continuation?: CanonicalSessionReaderContinuation;
  } = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const read = () => listSqliteSessionEntriesFromDatabase(database, resolved, scope, options);
    return options.continuation
      ? readWithCanonicalSessionReaderContinuation(database, options.continuation, read)
      : read();
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

export function listSqliteSessionEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedSqliteScope,
  scope: SessionEntryListScope,
  options: {
    deferParticipants?: true;
    captureCronRunUpdatedAt?: (oldestUpdatedAt: number | null) => void;
    captureCronRunSessionKey?: (sessionKey: string | null) => void;
  } = {},
): SessionEntrySummary[] {
  captureListingSource(database, scope);
  const deferParticipants =
    options.deferParticipants || scope.includeParticipants === false ? true : undefined;
  if (scope.sessionKeys && !scope.cronRetention && !scope.expiredCronRuns) {
    const sessionKeys = scope.sessionKeys;
    return runSqliteReadOperationSync(database.db, () => {
      const entries = readSelectedSessionEntriesInDatabase(
        database,
        sessionKeys,
        scope.projection === "list" ? {} : { fullEntryKeys: sessionKeys },
      );
      if (deferParticipants) {
        return entries;
      }
      return [
        ...projectSqliteSessionParticipantsBatch(
          database.db,
          new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
        ),
      ].map(([sessionKey, entry]) => ({ sessionKey, entry }));
    });
  }
  if (scope.cronRetention || scope.expiredCronRuns) {
    const expired = scope.expiredCronRuns;
    const requestedOwner = expired ? normalizeAgentId(expired.agentId) : undefined;
    const captured = withSqlitePostCommitPublications(sqlPublicationAnchor(database.db), () =>
      runSqliteReadSnapshotSync(database.db, () => {
        let entries: SessionEntrySummary[];
        if (scope.cronRetention) {
          const page = scope.cronRetention;
          const keys: string[] = [];
          for (const row of iterateSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<DB>(database.db)
              .selectFrom("session_nodes")
              .select("session_key")
              .where("session_key", ">", page.afterSessionKey ?? "")
              .orderBy("session_key"),
          )) {
            if (isCronRunSessionKey(row.session_key)) {
              keys.push(row.session_key);
              if (keys.length >= page.limit) {
                break;
              }
            }
          }
          options.captureCronRunSessionKey?.(keys.length === page.limit ? keys.at(-1)! : null);
          entries = readSelectedSessionEntriesInDatabase(database, keys);
        } else {
          const snapshot = readSessionEntryCache(database, {
            cache: false,
            projection: "list",
            deferParticipants: true,
          });
          entries = Array.from(iterateSessionEntriesForListing(snapshot));
        }
        let oldestUpdatedAt: number | null = null;
        let selected = entries.filter(({ sessionKey, entry }) => {
          if (
            !isCronRunSessionKey(sessionKey) ||
            (expired &&
              normalizeAgentId(parseAgentSessionKey(sessionKey)!.agentId) !== requestedOwner)
          ) {
            return false;
          }
          const updatedAt = entry.updatedAt ?? 0;
          oldestUpdatedAt = Math.min(oldestUpdatedAt ?? updatedAt, updatedAt);
          return !expired || updatedAt < expired.updatedBefore;
        });
        options.captureCronRunUpdatedAt?.(oldestUpdatedAt);
        if (!deferParticipants) {
          selected = [
            ...projectSqliteSessionParticipantsBatch(
              database.db,
              new Map(selected.map(({ sessionKey, entry }) => [sessionKey, entry])),
            ),
          ].map(([sessionKey, entry]) => ({ sessionKey, entry }));
        }
        // Capture only deletion candidates' payloads, in the same snapshot as their metadata.
        const rows = selected.length
          ? executeSqliteQuerySync(
              database.db,
              selectSessionEntryRows(database, "full")
                .select("updated_at")
                .where(
                  "session_key",
                  "in",
                  sqliteStringSet(selected.map(({ sessionKey }) => sessionKey)),
                ),
            ).rows
          : [];
        return { entries: selected, rows };
      }),
    );
    // Cold JSON decoding must not extend the worker's deferred read transaction.
    const fullRows = new Map(captured.rows.map((row) => [row.session_key, row]));
    for (const summary of captured.entries) {
      const row = fullRows.get(summary.sessionKey);
      if (row) {
        summary.entry = { ...parseSessionEntryJson(row), ...summary.entry };
      }
    }
    return captured.entries;
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
    deferParticipants,
  });
  // Deferred participant views are never cached and already own their decoded metadata.
  const cloneEntries = projection === "list" && scope.clone !== false && !deferParticipants;
  return Array.from(iterateSessionEntriesForListing(snapshot, cloneEntries));
}

/** Applies the listing visibility and canonical-key contract to an owned snapshot. */
function* iterateSessionEntriesForListing(
  snapshot: SessionEntryCacheSnapshot,
  cloneEntries = false,
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
    // Full snapshots own their nested values; list snapshots may share cached entries.
    yield {
      sessionKey,
      entry: cloneEntries ? structuredClone(entry) : entry,
    };
  }
}
