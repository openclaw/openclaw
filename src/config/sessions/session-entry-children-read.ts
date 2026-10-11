import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readSessionChildEntriesInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope, SessionEntrySummary } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export function listSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    return readSessionChildEntriesInDatabase(database, resolved.sessionKey, scope.projection);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
