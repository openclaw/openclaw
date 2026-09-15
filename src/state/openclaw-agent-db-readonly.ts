import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabaseClaim,
  isOpenClawAgentDatabasePathCurrent,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import { withCommittedOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-companion.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "./openclaw-agent-db-readonly-open.js";
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

type OpenClawAgentDatabaseReadOnlyBehavior = {
  throwOnMissingTable?: boolean;
  allowExtension?: boolean;
};

const readOnlyScope = new AsyncLocalStorage<OpenClawAgentDatabaseReadOnlyScope>();

/** One retained connection; its caller owns explicit close or worker retirement. */
export class OpenClawAgentDatabaseReadOnlyScope {
  private database?: OpenClawAgentReadOnlyDatabaseHandle;
  private target?: { agentId: string; path: string };

  close(): void {
    const database = this.database;
    // Descendant async contexts retain this object after run returns. Revoke reuse first.
    this.target = undefined;
    this.database = undefined;
    database?.close();
  }

  run<T>(target: { agentId: string; path: string }, operation: () => T): T {
    if (this.target?.agentId !== target.agentId || this.target.path !== target.path) {
      this.database?.close();
      this.database = undefined;
    }
    this.target = target;
    return readOnlyScope.run(this, operation);
  }

  matches(agentId: string, pathname: string): boolean {
    return this.target?.agentId === agentId && this.target.path === pathname;
  }

  read<T>(
    operation: (database: OpenClawAgentReadOnlyDatabase) => T,
    options: OpenClawAgentDatabaseOptions,
    behavior: OpenClawAgentDatabaseReadOnlyBehavior,
  ): OpenClawAgentDatabaseReadOnlyResult<T> {
    if (this.database?.db.isTransaction) {
      return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
    }
    if (this.database && !isOpenClawAgentDatabasePathCurrent(this.database)) {
      this.database.close();
      this.database = undefined;
    }
    if (!this.database) {
      const opened = openOpenClawAgentDatabaseReadOnly(options);
      if (!opened.found) {
        return opened;
      }
      this.database = opened.database;
    } else if (!hasOpenClawAgentReadOnlySchema(this.database)) {
      this.database.close();
      this.database = undefined;
      return { found: false, reason: "schema-missing" };
    }
    return readOpenClawAgentDatabaseReadOnly(this.database, operation, behavior);
  }
}

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
  const fresh = openOpenClawAgentDatabaseReadOnly(options);
  return fresh.found
    ? {
        found: true,
        database: fresh.database,
        claim: createOpenClawAgentDatabaseClaim(fresh.database, fresh.database.close),
      }
    : fresh;
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
      ? { found: true, value: operation(database) }
      : { found: false, reason: "database-missing" };
  }
  // Borrow only outside a transaction so readers see committed rows.
  // The writer owns reused handles; this call closes only fresh connections.
  const processOpened = behavior.allowExtension
    ? undefined
    : findOpenAgentDatabase({ ...options, agentId });
  if (processOpened?.db.isTransaction) {
    return withCommittedOpenClawAgentDatabaseReadOnly(
      processOpened,
      operation,
      { ...options, agentId },
      behavior,
    );
  }
  const reusable = processOpened && !processOpened.db.isTransaction ? processOpened : undefined;
  if (!reusable) {
    const scope = behavior.allowExtension ? undefined : readOnlyScope.getStore();
    return scope?.matches(agentId, pathname)
      ? scope.read(operation, { ...options, agentId }, behavior)
      : withFreshOpenClawAgentDatabaseReadOnly(operation, { ...options, agentId }, behavior);
  }
  // Share only this admission's fresh value; a later read must check again.
  const userVersion = assertSupportedAgentSchemaVersion(reusable.db, pathname);
  assertCanonicalAgentPersistenceVersion(reusable.db, pathname, userVersion);
  return readOpenClawAgentDatabaseReadOnly(reusable, operation, behavior);
}
