import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabaseClaim,
  isOpenClawAgentDatabasePathCurrent,
  findOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentDatabase,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "./openclaw-agent-db-readonly-open.js";
import {
  registerOpenClawAgentDatabaseSyncResource,
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "./openclaw-agent-db-resources.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawAgentDatabaseReadOnlyBehavior = {
  allowExtension?: boolean;
};

type ReadCandidate = Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope">;

type ReadTarget = OpenClawAgentDatabaseOptions & { agentId: string; path: string };
const readOnlyScope = new AsyncLocalStorage<OpenClawAgentDatabaseReadOnlyScope>();
const log = createSubsystemLogger("state/agent-db");
type ReadOnlyScopes = {
  paths: Map<string, OpenClawAgentDatabaseReadOnlyScope>;
  active: Set<OpenClawAgentDatabaseReadOnlyScope>;
  unregisterExit?: () => void;
};
const retainedScopes = resolveGlobalSingleton<ReadOnlyScopes>(
  Symbol.for("openclaw.agentDatabaseReadOnlyScopes"),
  () => ({ paths: new Map(), active: new Set() }),
);

/** One retained connection, revoked by its caller, database lifecycle, or idle expiry. */
export class OpenClawAgentDatabaseReadOnlyScope {
  private database?: OpenClawAgentReadOnlyDatabaseHandle;
  private target?: { agentId: string; path: string };
  private idleTimer?: ReturnType<typeof setTimeout>;
  private unregisterResource?: () => void;
  private borrowers = 0;
  private closing = false;

  constructor(private readonly cached = false) {}

  get hasRetainedConnection(): boolean {
    return this.database !== undefined;
  }

  invalidateProjection(
    databaseIdentity: string,
    invalidate: (database: DatabaseSync) => void,
  ): void {
    if (
      this.database &&
      findOpenClawAgentDatabaseIdentity(this.database)?.identity === databaseIdentity
    ) {
      invalidate(this.database.db);
    }
  }

  closeIfIdle(): void {
    if (this.borrowers === 0 && (!this.database?.db.isOpen || !this.database.db.isTransaction)) {
      this.discardConnection();
    }
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // Failed native cleanup retains custody and blocks reuse until the owner retries.
    this.database?.close();
    this.database = undefined;
    this.borrowers = 0;
    if (this.target && retainedScopes.paths.get(this.target.path) === this) {
      retainedScopes.paths.delete(this.target.path);
    }
    // Descendant async contexts retain this object after run returns. Revoke reuse first.
    this.target = undefined;
    this.unregisterResource?.();
    this.unregisterResource = undefined;
    retainedScopes.active.delete(this);
    if (retainedScopes.active.size === 0) {
      retainedScopes.unregisterExit?.();
      retainedScopes.unregisterExit = undefined;
    }
    this.closing = false;
  }

  private discardConnection(): void {
    const target = this.target;
    this.close();
    // Replacing a connection does not end the caller's still-active read scope.
    if (!this.cached) {
      this.target = target;
    }
  }

  private touch(): void {
    if (!this.database) {
      return;
    }
    if (this.idleTimer) {
      this.idleTimer.refresh();
      return;
    }
    this.idleTimer = runInSqliteMaintenanceContext(() =>
      setTimeout(() => {
        this.idleTimer = undefined;
        try {
          this.closeIfIdle();
        } catch (error) {
          log.warn("Idle agent read-only database cleanup failed", {
            path: this.database?.path,
            error,
          });
        } finally {
          this.touch();
        }
      }, SQLITE_IDLE_HANDLE_TTL_MS),
    );
    this.idleTimer.unref();
  }

  run<T>(target: { agentId: string; path: string }, operation: () => T): T {
    if (this.target?.agentId !== target.agentId || this.target.path !== target.path) {
      this.close();
    }
    this.target = target;
    return readOnlyScope.run(this, operation);
  }

  matches(agentId: string, pathname: string): boolean {
    return this.target?.agentId === agentId && this.target.path === pathname;
  }

  closeMatching(candidates: readonly ReadCandidate[]): void {
    const target = this.target;
    if (
      target &&
      candidates.some((candidate) => matchesAgentDatabaseReadCandidatePath(candidate, target.path))
    ) {
      this.close();
    }
  }

  private acquire(options: OpenClawAgentDatabaseOptions) {
    if (this.database && !isOpenClawAgentDatabasePathCurrent(this.database)) {
      this.discardConnection();
    }
    if (!this.database) {
      let opened: ReturnType<typeof openOpenClawAgentDatabaseReadOnly>;
      try {
        opened = openOpenClawAgentDatabaseReadOnly(options);
      } catch (error) {
        this.discardConnection();
        throw error;
      }
      if (!opened.found) {
        this.discardConnection();
        return opened;
      }
      this.database = opened.database;
      this.target = { agentId: this.database.agentId, path: this.database.path };
      try {
        this.unregisterResource = registerOpenClawAgentDatabaseSyncResource({
          ...this.target,
          revoke: () => this.close(),
          close: () => this.close(),
        });
        enableNodeSqliteKyselyStatementCache(this.database.db);
        retainedScopes.active.add(this);
        if (this.cached) {
          retainedScopes.paths.set(this.database.path, this);
        }
        retainedScopes.unregisterExit ??= registerSqliteCacheExitClose(() => {
          for (const scope of retainedScopes.active) {
            scope.close();
          }
        });
      } catch (error) {
        this.discardConnection();
        throw error;
      }
    } else if (!hasOpenClawAgentReadOnlySchema(this.database)) {
      this.discardConnection();
      return { found: false, reason: "schema-missing" } as const;
    }
    const requestedAgentId = normalizeAgentId(options.agentId);
    if (this.database.agentId !== requestedAgentId) {
      throw new Error(
        `OpenClaw agent database ${this.database.path} belongs to agent ${this.database.agentId}; requested agent ${requestedAgentId}.`,
      );
    }
    observeOpenClawDatabaseMaintenanceResource(this.unregisterResource);
    this.touch();
    return { found: true, database: this.database } as const;
  }

  private releaseBorrow(database: OpenClawAgentReadOnlyDatabaseHandle): void {
    if (this.database !== database) {
      return;
    }
    this.borrowers--;
    if (
      this.cached &&
      this.borrowers === 0 &&
      this.database &&
      (!this.database.db.isOpen || this.database.db.isTransaction)
    ) {
      this.discardConnection();
    } else {
      this.touch();
    }
  }

  private assertUsable(): void {
    if (this.closing) {
      throw new Error("Agent read-only database native cleanup is pending");
    }
  }

  retain(options: OpenClawAgentDatabaseOptions) {
    this.assertUsable();
    const opened =
      this.database?.db.isOpen && this.database.db.isTransaction
        ? openOpenClawAgentDatabaseReadOnly(options)
        : this.acquire(options);
    if (!opened.found) {
      return opened;
    }
    const { database } = opened;
    const shared = database === this.database;
    if (shared) {
      this.borrowers++;
    }
    return {
      found: true,
      database,
      claim: createOpenClawAgentDatabaseClaim(database, () => {
        if (shared) {
          this.releaseBorrow(database);
        } else {
          database.close();
        }
      }),
    } as const;
  }

  read<T>(
    operation: (database: OpenClawAgentReadOnlyDatabase) => T,
    options: OpenClawAgentDatabaseOptions,
  ): OpenClawAgentDatabaseReadOnlyResult<T> {
    this.assertUsable();
    if (this.database?.db.isOpen && this.database.db.isTransaction) {
      return withFreshOpenClawAgentDatabaseReadOnly(operation, options);
    }
    const opened = this.acquire(options);
    if (!opened.found) {
      return opened;
    }
    this.borrowers++;
    try {
      return readOpenClawAgentDatabase(opened.database, operation);
    } catch (error) {
      if (this.cached && this.borrowers === 1) {
        this.discardConnection();
      }
      throw error;
    } finally {
      this.releaseBorrow(opened.database);
    }
  }
}

function cachedScope(options: ReadTarget): OpenClawAgentDatabaseReadOnlyScope {
  let scope = retainedScopes.paths.get(options.path);
  if (!scope) {
    scope = new OpenClawAgentDatabaseReadOnlyScope(true);
    scope.run(options, () => {});
    retainedScopes.paths.set(options.path, scope);
  }
  return scope;
}

/** Committed worker receipts invalidate projections on retained readers without running SQL. */
export function invalidateOpenClawAgentReadOnlyProjections(
  databaseIdentity: string,
  invalidate: (database: DatabaseSync) => void,
): void {
  for (const scope of retainedScopes.active) {
    scope.invalidateProjection(databaseIdentity, invalidate);
  }
}

/** Writable admission retires an idle reader before opening the same physical file. */
export function closeIdleOpenClawAgentDatabaseReadOnly(pathname: string): void {
  retainedScopes.paths.get(pathname)?.closeIfIdle();
}

/** Called only after the native worker has settled preceding reads, including explicit scopes. */
export function closeOpenClawAgentDatabaseReadOnlyCandidates(
  candidates: readonly ReadCandidate[],
): void {
  for (const scope of retainedScopes.active) {
    scope.closeMatching(candidates);
  }
}

export function retainCachedOpenClawAgentDatabaseReadOnly(options: ReadTarget) {
  return cachedScope(options).retain(options);
}

/** Reuse the caller's matching read scope, or this thread's idle-expiring reader. */
export function withScopedOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: ReadTarget,
  behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  if (behavior.allowExtension) {
    return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
  }
  const scope = readOnlyScope.getStore();
  return (scope?.matches(options.agentId, options.path) ? scope : cachedScope(options)).read(
    operation,
    options,
  );
}
