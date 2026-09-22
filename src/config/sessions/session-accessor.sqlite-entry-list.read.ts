import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import {
  readSessionEntryCache,
  type SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

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
