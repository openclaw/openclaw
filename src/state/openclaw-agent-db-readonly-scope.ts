import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
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
  readOpenClawAgentDatabaseSnapshot,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "./openclaw-agent-db-readonly-open.js";
import { registerOpenClawAgentDatabaseSyncResource } from "./openclaw-agent-db-resources.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseReadValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawAgentDatabaseReadOnlyBehavior = {
  allowExtension?: boolean;
  /** Consume admission and read kernels in one synchronous deferred transaction. */
  snapshot?: boolean;
};

type ReadTarget = OpenClawAgentDatabaseOptions & { agentId: string; path: string };
type ReadScopeTarget = {
  agentId: string;
  path: string;
  validation?: OpenClawAgentDatabaseReadValidation;
};
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
  private target?: ReadScopeTarget;
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

  run<T>(target: ReadScopeTarget, operation: () => T): T {
    if (this.target?.agentId !== target.agentId || this.target.path !== target.path) {
      this.close();
    }
    this.target = target;
    return readOnlyScope.run(this, operation);
  }

  matches(agentId: string, pathname: string): boolean {
    return this.target?.agentId === agentId && this.target.path === pathname;
  }

  private acquire(
    options: OpenClawAgentDatabaseOptions,
    onAdmitted?: (database: OpenClawAgentReadOnlyDatabaseHandle) => void,
    snapshot = false,
  ) {
    const finish = (database: OpenClawAgentReadOnlyDatabaseHandle) => {
      const requestedAgentId = normalizeAgentId(options.agentId);
      if (database.agentId !== requestedAgentId) {
        throw new Error(
          `OpenClaw agent database ${database.path} belongs to agent ${database.agentId}; requested agent ${requestedAgentId}.`,
        );
      }
      observeOpenClawDatabaseMaintenanceResource(this.unregisterResource);
      this.touch();
      onAdmitted?.(database);
      return { found: true, database } as const;
    };
    if (this.database && !isOpenClawAgentDatabasePathCurrent(this.database)) {
      this.discardConnection();
    }
    const retained = this.database !== undefined;
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
      this.target = { ...this.target, agentId: this.database.agentId, path: this.database.path };
      try {
        this.unregisterResource = registerOpenClawAgentDatabaseSyncResource({
          agentId: this.target.agentId,
          path: this.target.path,
          revoke: () => this.close(),
          close: () => this.close(),
        });
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
    }
    const database = this.database;
    if (
      this.target?.validation &&
      !adoptOpenClawAgentDatabaseValidation(database, this.target.validation)
    ) {
      throw new Error("Session reader validation does not match its current physical owner");
    }
    if (!retained || snapshot) {
      return finish(database);
    }
    let result: ReturnType<typeof openOpenClawAgentDatabaseReadOnly> = {
      found: false,
      reason: "schema-missing",
    };
    if (
      !hasOpenClawAgentReadOnlySchema(database, () => {
        result = finish(database);
      })
    ) {
      this.discardConnection();
    }
    return result;
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
    behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
  ): OpenClawAgentDatabaseReadOnlyResult<T> {
    this.assertUsable();
    if (this.database?.db.isOpen && this.database.db.isTransaction) {
      return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
    }
    let result: OpenClawAgentDatabaseReadOnlyResult<T> = {
      found: false,
      reason: "schema-missing",
    };
    const opened = this.acquire(
      options,
      (database) => {
        this.borrowers++;
        try {
          result = behavior.snapshot
            ? readOpenClawAgentDatabaseSnapshot(database, operation)
            : readOpenClawAgentDatabase(database, operation);
          if (!result.found) {
            this.discardConnection();
          }
        } catch (error) {
          if (this.cached && this.borrowers === 1) {
            this.discardConnection();
          }
          throw error;
        } finally {
          this.releaseBorrow(database);
        }
      },
      behavior.snapshot,
    );
    return opened.found ? result : opened;
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
    behavior,
  );
}
