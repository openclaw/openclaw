import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AgentDeletionCleanupWorkerAuthority } from "./agent-deletion-cleanup.types.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { WorkerLeaseScope } from "./openclaw-state-lease-worker-owner.js";

type AgentDeletionCleanupRow = {
  agentId: string;
  operationId: string;
  cleanupCompleted: boolean;
};

type AgentDeletionDatabaseCleanupScope = {
  agentId: string;
  ownsDatabase: boolean;
  path: string;
  canonicalPath?: string;
  statePath: string;
  assertCurrent: () => void;
  assertJournal: (statePath: string, entries: readonly AgentDeletionCleanupRow[]) => string;
  registerClose: (close: () => Promise<void>) => void;
  retryClose: () => Promise<void>;
  withCommit: (commit: () => void) => void;
  worker?: { lease: WorkerLeaseScope; guard: AgentDeletionWorkerGuard };
  assertCurrentHost: () => void;
  workerOwned?: true;
};

const databaseCleanup = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionDatabaseCleanup"),
  () => new AsyncLocalStorage<AgentDeletionDatabaseCleanupScope>(),
);
const cleanupHandles = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionDatabaseCleanupHandles"),
  () => new Map<OpenClawAgentDatabase, AgentDeletionDatabaseCleanupScope>(),
);
const cleanupExecutions = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionDatabaseCleanupExecutions"),
  () => new Map<object, AgentDeletionDatabaseCleanupScope>(),
);

/** The lifecycle owner supplies live closures, never a transferable operation id. */
export function createAgentDeletionDatabaseCleanup(owner: {
  agentId: string;
  statePath: string;
  assertAdmission: () => void | Promise<void>;
  withCommit: (commit: () => void) => void;
  assertCurrent: () => void;
  assertCurrentAsync?: () => Promise<void>;
  assertJournal: (statePath: string, entries: readonly AgentDeletionCleanupRow[]) => string;
  workerAuthority?: AgentDeletionCleanupWorkerAuthority;
}) {
  return async <T>(
    target: { agentId: string; path: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    const targetAgentId = normalizeAgentId(target.agentId);
    const targetPath = path.resolve(target.path);
    const targetIdentity = readDatabasePathIdentitySync(targetPath);
    const assertTargetCurrent = () => {
      const current = readDatabasePathIdentitySync(targetPath);
      if (
        current.key !== targetIdentity.key ||
        current.birthtime !== targetIdentity.birthtime ||
        current.canonicalPath !== targetIdentity.canonicalPath
      ) {
        throw new Error("Agent deletion database target changed before cleanup");
      }
    };
    const runCleanup = async (worker?: AgentDeletionDatabaseCleanupScope["worker"]): Promise<T> => {
      let active = true;
      const closers = new Set<() => Promise<void>>();
      const closeHandles = async () => {
        const errors: unknown[] = [];
        for (const close of [...closers].toReversed()) {
          try {
            await close();
            closers.delete(close);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 0) {
          cleanupExecutions.delete(scope);
        }
        return errors;
      };
      const assertActive = () => {
        if (!active) {
          throw new Error("Agent deletion database cleanup is no longer active.");
        }
        assertTargetCurrent();
      };
      const assertCurrentAsync = async () => {
        assertActive();
        if (worker && owner.assertCurrentAsync) {
          await owner.assertCurrentAsync();
          assertActive();
          worker.lease.assertCurrent();
        } else {
          owner.assertCurrent();
        }
      };
      const scope: AgentDeletionDatabaseCleanupScope = {
        agentId: targetAgentId,
        ownsDatabase: targetAgentId === normalizeAgentId(owner.agentId),
        path: targetPath,
        canonicalPath: targetIdentity.canonicalPath,
        statePath: path.resolve(owner.statePath),
        worker,
        assertCurrentHost: () => {
          assertActive();
          if (worker) {
            worker.lease.assertCurrent();
            owner.workerAuthority!.assertCurrentHost();
          } else {
            owner.assertCurrent();
          }
        },
        assertCurrent: () => {
          assertActive();
          owner.assertCurrent();
        },
        assertJournal: (statePath, entries) => {
          assertActive();
          return owner.assertJournal(statePath, entries);
        },
        registerClose: (close) => {
          assertActive();
          closers.add(close);
        },
        retryClose: async () => {
          if (active) {
            throw new Error("Agent database belongs to an active deletion cleanup.");
          }
          const errors = await closeHandles();
          if (errors.length > 0) {
            throw new AggregateError(errors, "Agent deletion database close retry failed.");
          }
        },
        withCommit: (commit) => {
          assertActive();
          owner.withCommit(commit);
        },
      };
      return await databaseCleanup.run(scope, async () => {
        let outcome: Result<T, unknown>;
        const closeErrors: unknown[] = [];
        try {
          await assertCurrentAsync();
          // A failed cold close keeps its tag and native lease. A fresh exact owner
          // retries only that settled close; it never adopts the expired write scope.
          for (const previous of new Set([
            ...cleanupHandles.values(),
            ...cleanupExecutions.values(),
          ])) {
            if (
              previous.statePath === scope.statePath &&
              previous.agentId === scope.agentId &&
              previous.path === scope.path
            ) {
              await previous.retryClose();
              await assertCurrentAsync();
            }
          }
          await owner.assertAdmission();
          scope.assertCurrentHost();
          // A shared store keeps its surviving owner and ordinary borrowers admitted.
          if (scope.ownsDatabase) {
            cleanupExecutions.set(scope, scope);
          }
          const value = await run();
          // Callback settlement retires local admission before any owner check can yield.
          active = false;
          outcome = ok(value);
        } catch (error) {
          outcome = err(error);
        } finally {
          // Retire callback authority before awaiting disposal; failed closes keep their tags.
          active = false;
          closeErrors.push(...(await closeHandles()));
        }
        if (!outcome.ok) {
          throw closeErrors.length > 0
            ? new AggregateError(
                [outcome.error, ...closeErrors],
                "Agent deletion database cleanup failed.",
              )
            : outcome.error;
        }
        if (closeErrors.length > 0) {
          throw closeErrors.length === 1
            ? closeErrors[0]
            : new AggregateError(closeErrors, "Agent deletion database cleanup failed.");
        }
        if (worker && owner.assertCurrentAsync) {
          await owner.assertCurrentAsync();
        } else {
          owner.assertCurrent();
        }
        assertTargetCurrent();
        return outcome.value;
      });
    };
    return owner.workerAuthority
      ? owner.workerAuthority.runWithLeaseAdmission((lease, guard) => runCleanup({ lease, guard }))
      : runCleanup();
  };
}

/** The canonical agent executor owns native close and settlement in its worker. */
export function withAgentDeletionWorkerDatabaseCleanup<T>(
  owner: Pick<
    AgentDeletionDatabaseCleanupScope,
    | "agentId"
    | "ownsDatabase"
    | "path"
    | "statePath"
    | "assertCurrent"
    | "assertJournal"
    | "withCommit"
  >,
  run: () => T,
): T {
  return databaseCleanup.run(
    {
      ...owner,
      workerOwned: true,
      assertCurrentHost: owner.assertCurrent,
      registerClose: () => {},
      retryClose: async () => {},
    },
    run,
  );
}

export function getAgentDeletionDatabaseCleanup(
  params: OpenClawAgentDatabaseOptions & { statePath?: string },
): AgentDeletionDatabaseCleanupScope | undefined {
  const scope = databaseCleanup.getStore();
  if (!scope) {
    return undefined;
  }
  const pathname = resolveOpenClawAgentSqlitePath(params);
  if (
    scope.agentId !== normalizeAgentId(params.agentId) ||
    (scope.path !== pathname && scope.canonicalPath !== pathname)
  ) {
    return undefined;
  }
  const statePath = params.statePath ?? resolveOpenClawStateSqlitePath(params.env ?? process.env);
  if (scope.statePath !== path.resolve(statePath)) {
    throw new Error("Agent deletion database cleanup belongs to another state database.");
  }
  return scope;
}

/** Resource registration captures only the cleanup scope that admitted this target. */
export function captureAgentDeletionResourceOwner(
  matches: (target: { agentId: string; path: string }) => boolean,
): object | undefined {
  const scope = databaseCleanup.getStore();
  if (
    !scope?.ownsDatabase ||
    (!matches(scope) &&
      (!scope.canonicalPath || !matches({ agentId: scope.agentId, path: scope.canonicalPath })))
  ) {
    return undefined;
  }
  scope.assertCurrentHost();
  return scope;
}

export function assertAgentDeletionDatabaseCleanupAccess(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): void {
  const scope = getAgentDeletionDatabaseCleanup(options);
  const owner = cleanupHandles.get(database);
  if (owner && owner !== scope) {
    throw new Error("Agent database belongs to an active deletion cleanup.");
  }
  scope?.assertCurrent();
}

export function assertAgentDeletionCleanupAliases(
  options: OpenClawAgentDatabaseOptions,
  isSamePath: (left: string, right: string) => boolean,
): void {
  // Only cleanup-held files need this rare physical alias check on a cache miss.
  const pathname = resolveOpenClawAgentSqlitePath(options);
  for (const owned of cleanupHandles.keys()) {
    if (isSamePath(owned.path, pathname)) {
      assertAgentDeletionDatabaseCleanupAccess(owned, options);
    }
  }
  for (const scope of cleanupExecutions.values()) {
    if (isSamePath(scope.path, pathname) && getAgentDeletionDatabaseCleanup(options) !== scope) {
      throw new Error("Agent database belongs to an active deletion cleanup.");
    }
  }
}

export function assertAgentDeletionExecutionCleanupAccess(
  execution: object,
  options: OpenClawAgentDatabaseOptions,
): void {
  const owner = cleanupExecutions.get(execution);
  const scope = getAgentDeletionDatabaseCleanup(options);
  if (owner && owner !== scope) {
    throw new Error("Agent database belongs to an active deletion cleanup.");
  }
  scope?.assertCurrentHost();
}

/** Only a newly created executor belongs to cleanup; borrowing never transfers ownership. */
export function registerAgentDeletionExecutionCleanup(
  execution: object,
  options: OpenClawAgentDatabaseOptions,
  close: () => Promise<void>,
): void {
  const scope = getAgentDeletionDatabaseCleanup(options);
  if (!scope?.worker || !scope.ownsDatabase) {
    return;
  }
  scope.assertCurrentHost();
  if (cleanupExecutions.get(execution) === scope) {
    return;
  }
  cleanupExecutions.set(execution, scope);
  scope.registerClose(async () => {
    await close();
    cleanupExecutions.delete(execution);
  });
}

export function registerAgentDeletionDatabaseCleanup(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): AgentDeletionDatabaseCleanupScope | undefined {
  const scope = getAgentDeletionDatabaseCleanup(options);
  scope?.assertCurrent();
  if (!scope?.ownsDatabase || scope.workerOwned) {
    return undefined;
  }
  cleanupHandles.set(database, scope);
  return scope;
}

/** Release the tag only after the native owner has closed and released its lease. */
export function releaseAgentDeletionDatabaseCleanup(database: OpenClawAgentDatabase): void {
  cleanupHandles.delete(database);
}
