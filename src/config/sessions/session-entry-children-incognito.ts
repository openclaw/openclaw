import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readSessionChildEntriesInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope, SessionEntrySummary } from "./session-accessor.types.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export function listIncognitoSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
): SessionEntrySummary[] {
  if (!isIncognitoSessionKey(scope.sessionKey)) {
    throw new Error("Native child discovery is reserved for incognito sessions");
  }
  const memory = getSessionActorStorageBinding({ ...scope, sessionKey: undefined });
  if (memory) {
    return memory.actor
      .storage!.readCurrent(
        { type: "session.entries.read", input: { projection: scope.projection } },
        memory.authority,
      )
      .filter(
        ({ sessionKey, entry }) =>
          sessionKey !== scope.sessionKey &&
          (entry.parentSessionKey === scope.sessionKey || entry.spawnedBy === scope.sessionKey),
      )
      .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  }
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    return readSessionChildEntriesInDatabase(database, resolved.sessionKey, scope.projection);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
