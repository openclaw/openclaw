import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { readSelectedSessionEntryMetadataInDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
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
  return readSelectedSessionEntryMetadataInDatabase(database, sessionKeys, continuation).map(
    ({ sessionKey, entry }) => ({
      sessionKey,
      entry: {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
        ...(entry.subagentRecovery ? { subagentRecovery: entry.subagentRecovery } : {}),
      },
    }),
  );
}
