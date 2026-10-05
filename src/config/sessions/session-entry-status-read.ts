import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntryStatus } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  hasSessionEntriesByStatus,
  readSessionEntriesByStatus,
} from "./session-accessor.sqlite-status.js";
import type { SessionAccessScope, SessionEntrySummary } from "./session-accessor.types.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
  withSessionStoreReaderInWorker,
} from "./session-entry-read-runtime.js";

async function readSessionStatusSelection(
  input: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
  presenceOnly: boolean,
) {
  const { scope, agentId } = captureSessionEntryReadScope({ ...input, sessionKey: "" });
  const selected = [...new Set(statuses)];
  if (selected.length === 0) {
    return { entries: [], statusFound: false };
  }
  if (isNativeSessionEntryRead(scope, agentId)) {
    const options = toDatabaseOptions(resolveSqliteScope(scope));
    if (!presenceOnly) {
      return {
        entries: readSessionEntriesByStatus(openOpenClawAgentDatabase(options), selected),
        statusFound: false,
      };
    }
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => hasSessionEntriesByStatus(database, selected),
      options,
    );
    return {
      entries: [],
      statusFound: read.found ? read.value : read.reason !== "database-missing",
    };
  }
  const storePath =
    scope.storePath || (agentId && resolveOpenClawAgentSqlitePath({ agentId, env: scope.env }));
  if (!storePath) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  const source = createOpenClawAgentDatabasePathMatcher();
  let assertAdmitted: (() => void) | undefined;
  const result = await withSessionStoreReaderInWorker(
    { ...scope, agentId, storePath },
    async ({ reader, database, logicalAgentId, assertCurrent }) => {
      if (!presenceOnly) {
        assertAdmitted = () => {
          assertAgentDatabaseAdmitted(logicalAgentId, { env: database.env });
          assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
        };
        assertAdmitted();
      }
      source(database.path, database.path);
      const read = await reader.readExactEntries({
        env: database.env,
        sessionKeys: [],
        statusSelection: { statuses: selected, presenceOnly },
      });
      assertCurrent();
      assertAdmitted?.();
      return read;
    },
    { dataOnly: true },
  );
  if (!source.isCurrent()) {
    throw new Error("Session database changed while reading recovery status; retry the read.");
  }
  assertAdmitted?.();
  return result;
}

/** Unknown existing schemas remain eligible for recovery's writable admission owner. */
export async function hasSessionEntriesByStatusReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): Promise<boolean> {
  return (await readSessionStatusSelection(scope, statuses, true)).statusFound === true;
}

export async function listSessionEntriesByStatus(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): Promise<SessionEntrySummary[]> {
  return (await readSessionStatusSelection(scope, statuses, false)).entries.filter(
    ({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey),
  );
}
