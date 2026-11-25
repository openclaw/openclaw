// Synchronous host callers retain writable admission; read workers use the shared selection kernel.
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  readExactSessionEntryCandidatesWithDatabase,
  resolveSessionEntryWithDatabase,
  type SessionEntryCandidatesScope,
  type SessionEntryResolutionOptions,
} from "./session-accessor.sqlite-exact-read.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const withAdmittedSessionEntryDatabase: typeof withOpenClawAgentDatabaseReadOnly = (
  read,
  options,
) => ({ found: true, value: read(openOpenClawAgentDatabase(options)) });

/** Loads one session entry from the additive SQLite session store. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope).existing;
}

/** Resolve a canonical entry with the caller's existing synchronous admission contract. */
export function resolveSessionEntry(
  scope: SessionAccessScope,
  options: SessionEntryResolutionOptions = {},
) {
  return resolveSessionEntryWithDatabase(
    scope,
    options,
    options.readOnly ? withOpenClawAgentDatabaseReadOnly : withAdmittedSessionEntryDatabase,
  );
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSessionEntry(scope: SessionEntryReadScope): ExactSessionEntry | undefined {
  return loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: [scope.sessionKey],
    readOnly: false,
  })[0];
}

/** Read exact candidates through either the existing reader or writable admission owner. */
export function loadExactSessionEntryCandidates(
  scope: SessionEntryCandidatesScope,
): ExactSessionEntry[] {
  return readExactSessionEntryCandidatesWithDatabase(
    scope,
    scope.readOnly ? withOpenClawAgentDatabaseReadOnly : withAdmittedSessionEntryDatabase,
  );
}
