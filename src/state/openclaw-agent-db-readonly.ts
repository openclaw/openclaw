import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { sqlPublicationAnchor, type EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  retainAgentDatabase,
} from "./openclaw-agent-db-borrower.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentDatabase,
  readOpenClawAgentDatabaseSnapshot,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import {
  retainCachedOpenClawAgentDatabaseReadOnly,
  withScopedOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyBehavior,
  OpenClawAgentDatabaseReadOnlyScope,
} from "./openclaw-agent-db-readonly-scope.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

const companions = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseReadOnlyCompanions"),
  () => new WeakMap<EngineConnection, OpenClawAgentDatabaseReadOnlyScope>(),
);

export {
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
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
  if (isArtifactPreservingStateRead("agent", resolveOpenClawAgentSqlitePath(options))) {
    const inspected = openOpenClawAgentDatabaseReadOnly(options);
    return inspected.found
      ? {
          found: true,
          database: inspected.database,
          claim: createOpenClawAgentDatabaseClaim(inspected.database, inspected.database.close),
        }
      : inspected;
  }
  const opened = findOpenAgentDatabase(options);
  if (opened && !opened.db.isTransaction) {
    return {
      found: true,
      database: opened,
      claim: createOpenClawAgentDatabaseClaim(opened, retainAgentDatabase(opened.db)),
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
  if (isArtifactPreservingStateRead("agent", pathname)) {
    return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
  }
  if (isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env })) {
    return { found: false, reason: "database-missing" };
  }
  // Borrow only outside a transaction so readers see committed rows.
  // The writer owns reused handles; this call closes only fresh connections.
  const processOpened = behavior.allowExtension
    ? undefined
    : findOpenAgentDatabase({ ...options, agentId });
  if (processOpened?.db.isTransaction) {
    /** Keep committed reads separate from the writer using the ordinary reader lifecycle. */
    const companionOptions = { ...options, agentId };
    let scope = companions.get(processOpened.db);
    if (!scope) {
      scope = new OpenClawAgentDatabaseReadOnlyScope(true);
      const owned = scope;
      registerNodeSqliteDisposeCallback(sqlPublicationAnchor(processOpened.db), () =>
        owned.close(),
      );
      companions.set(processOpened.db, scope);
    }
    const owned = scope;
    return owned.run({ agentId: processOpened.agentId, path: processOpened.path }, () =>
      owned.read(operation, companionOptions, behavior),
    );
  }
  if (!processOpened) {
    return withScopedOpenClawAgentDatabaseReadOnly(
      operation,
      { ...options, agentId, path: pathname },
      behavior,
    );
  }
  if (behavior.snapshot) {
    return readOpenClawAgentDatabaseSnapshot(processOpened, operation);
  }
  // The migration owner publishes changes to the handle's shared schema admission.
  return runSqliteReadOperationSync(processOpened.db, () =>
    readOpenClawAgentDatabase(processOpened, operation),
  );
}
