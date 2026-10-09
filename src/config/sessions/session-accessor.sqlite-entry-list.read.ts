import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
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
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import {
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

/** Select listing facts without hydrating the store; creation retains only its target payloads. */
export function readSelectedSessionEntriesInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKeys: readonly string[],
  options: {
    continuation?: CanonicalSessionReaderContinuation;
    fullEntryKeys?: readonly string[];
    label?: string;
  } = {},
): SessionEntrySummary[] {
  return readWithCanonicalSessionReaderContinuation(database, options.continuation, () => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const keys = new Set(sessionKeys);
    const fullEntryKeys = new Set(options.fullEntryKeys);
    const query = selectSessionEntryRows(database, "list", options.fullEntryKeys)
      .select("updated_at")
      .orderBy("session_key");
    const db = getNodeSqliteKysely<DB>(database.db);
    const pending = db.selectFrom("session_canonical_validation_pending").select("session_key");
    let selected = db
      .selectFrom("session_nodes")
      .select("session_key")
      .where("session_key", "in", sqliteStringSet(sessionKeys));
    if (options.label !== undefined) {
      selected = selected.union(
        db
          .selectFrom("session_nodes")
          .select("session_key")
          .where("label", "=", options.label.trim()),
      );
    }
    // Warm admission permits raw metadata changes. The listing contract still
    // rejects delivery-canonical sibling drift, so include its existing dirty set.
    // Older readers have no dirty set and retain their full validation inventory.
    const rows = executeSqliteQuerySync(
      database.db,
      hasCanonicalSessionValidationProjection(database)
        ? query.where("session_key", "in", pending.union(selected))
        : query,
    ).rows;
    const entries: SessionEntrySummary[] = [];
    for (const row of rows) {
      if (isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(
        row,
        fullEntryKeys.has(row.session_key) ? "full" : "list",
      );
      if (!entry) {
        continue;
      }
      validateDeliveryCanonicalSessionEntry(row.session_key, entry);
      if (
        keys.has(row.session_key) ||
        (options.label !== undefined && entry.label === options.label)
      ) {
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
  options: {
    deferParticipants?: true;
    continuation?: CanonicalSessionReaderContinuation;
  } = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (scope.sessionKeys && !scope.cronRetention && !scope.expiredCronRuns) {
      captureListingSource(database, scope);
      const sessionKeys = scope.sessionKeys;
      const readSelected = () =>
        runSqliteReadOperationSync(database.db, () => {
          const entries = readSelectedSessionEntriesInDatabase(
            database,
            sessionKeys,
            scope.projection === "list" ? {} : { fullEntryKeys: sessionKeys },
          );
          if (options.deferParticipants || scope.includeParticipants === false) {
            return entries;
          }
          return [
            ...projectSqliteSessionParticipantsBatch(
              database.db,
              new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
            ),
          ].map(([sessionKey, entry]) => ({ sessionKey, entry }));
        });
      return options.continuation
        ? readWithCanonicalSessionReaderContinuation(database, options.continuation, readSelected)
        : readSelected();
    }
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
  options: { deferParticipants?: true } = {},
): SessionEntrySummary[] {
  captureListingSource(database, scope);
  const deferParticipants =
    options.deferParticipants || scope.includeParticipants === false ? true : undefined;
  if (scope.cronRetention || scope.expiredCronRuns) {
    const expired = scope.expiredCronRuns;
    const requestedOwner = expired ? normalizeAgentId(expired.agentId) : undefined;
    const captured = withSqlitePostCommitPublications(database.db, () =>
      runSqliteDeferredTransactionSync(database.db, () => {
        const snapshot = readSessionEntryCache(database, {
          cache: false,
          projection: "list",
          deferParticipants,
        });
        // Sibling metadata and participants still cross complete listing validation.
        const entries = Array.from(iterateSessionEntriesForListing(snapshot));
        const selected = entries.filter(
          ({ sessionKey, entry }) =>
            isCronRunSessionKey(sessionKey) &&
            (scope.cronRetention ||
              (expired !== undefined &&
                normalizeAgentId(parseAgentSessionKey(sessionKey)!.agentId) === requestedOwner &&
                !((entry.updatedAt ?? 0) >= expired.updatedBefore))),
        );
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
  return Array.from(
    iterateSessionEntriesForListing(
      snapshot,
      projection === "list" && scope.clone !== false,
      scope.sessionKeys ? new Set(scope.sessionKeys) : undefined,
    ),
  );
}

/** Applies the listing visibility and canonical-key contract to an owned snapshot. */
function* iterateSessionEntriesForListing(
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
      entry: cloneEntries ? structuredClone(entry) : entry,
    };
  }
}
