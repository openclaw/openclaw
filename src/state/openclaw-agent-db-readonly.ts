import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import { withCommittedOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-companion.js";
import {
  readOpenClawAgentDatabase,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import {
  retainCachedOpenClawAgentDatabaseReadOnly,
  withScopedOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyBehavior,
} from "./openclaw-agent-db-readonly-scope.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertSupportedAgentSchemaVersion,
} from "./openclaw-agent-db-schema-read.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
} from "./openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

export {
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
  type OpenClawAgentDatabaseReadOnlyOpenResult,
} from "./openclaw-agent-db-readonly-open.js";

/**
 * Look up a process-held handle without adopting writer-side failures.
 *
 * Read-only reads are meant to survive a latched open failure or an ownership
 * mismatch that only the writable lifecycle cares about; those callers fall
 * back to a fresh connection, which reports the precise reason.
 */
function findOpenAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  try {
    return getOpenClawAgentDatabaseIfOpen(options);
  } catch {
    return undefined;
  }
}

/** Retain an existing store across awaits without materializing a writable database. */
export function retainOpenClawAgentDatabaseReadOnly(
  options: OpenClawAgentDatabaseOptions,
):
  | { found: true; database: OpenClawAgentReadOnlyDatabase; claim: OpenClawAgentDatabaseClaim }
  | { found: false; reason: "database-missing" | "schema-missing" } {
  const opened = findOpenAgentDatabase(options);
  if (opened && !opened.db.isTransaction) {
    const borrowed = borrowOpenClawAgentDatabase(options);
    return {
      found: true,
      database: opened,
      claim: createOpenClawAgentDatabaseClaim(opened, borrowed.release),
    };
  }
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  return retainCachedOpenClawAgentDatabaseReadOnly({ ...options, agentId, path: pathname });
}

/** Read agent state without creating, registering, migrating, or joining its writable lifecycle. */
export function withOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  if (isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env })) {
    // Read-only misses must not create process-lifetime handles; only creation and
    // write paths may materialize the process-held incognito database.
    const database = getOpenClawAgentDatabaseIfOpen({ ...options, agentId });
    if (database && behavior.allowExtension) {
      throw new Error("Extension-capable read-only access is unavailable for incognito databases.");
    }
    return database
      ? readOpenClawAgentDatabase(database, operation)
      : { found: false, reason: "database-missing" };
  }
  // Borrow only outside a transaction so readers see committed rows.
  // The writer owns reused handles; this call closes only fresh connections.
  const processOpened = behavior.allowExtension
    ? undefined
    : findOpenAgentDatabase({ ...options, agentId });
  if (processOpened?.db.isTransaction) {
    return withCommittedOpenClawAgentDatabaseReadOnly(processOpened, operation, {
      ...options,
      agentId,
    });
  }
  if (!processOpened) {
    return withScopedOpenClawAgentDatabaseReadOnly(
      operation,
      { ...options, agentId, path: pathname },
      behavior,
    );
  }
  // The handle's admission owner refreshes these facts after DDL or a foreign commit.
  const userVersion = assertSupportedAgentSchemaVersion(processOpened.db, pathname);
  assertCanonicalAgentPersistenceVersion(processOpened.db, pathname, userVersion);
  return readOpenClawAgentDatabase(processOpened, operation);
}
