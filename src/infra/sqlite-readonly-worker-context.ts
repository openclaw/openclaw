import { AsyncContext } from "../shared/async-context.js";
import { runWithAsyncStore } from "../shared/async-store.js";
import { materializeErrorStack, throwSettledAggregate } from "./error-graph-internal.js";
import type { SqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session-types.js";

export type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  deadlineOwnedByCaller: boolean;
  asyncOnly?: true;
  worker?: SqliteReadOnlyWorkerSession;
  releaseReadWorker?: () => Promise<void>;
};
export const readOnlyWorkerScope = new AsyncContext<SqliteReadOnlyWorkerScope>(
  Symbol("sqliteReadOnlyWorkerScope"),
);

export class SqliteReadOnlyWorkerScopeClosedError extends Error {
  readonly code = "SQLITE_READONLY_WORKER_SCOPE_CLOSED";

  constructor() {
    super("SQLite read-only worker scope closed");
  }
}

export class SqliteSynchronousPreparationError extends Error {
  readonly code = "SQLITE_SYNCHRONOUS_PREPARATION_DISALLOWED";

  constructor(pathname: string) {
    super(
      `Doctor refused synchronous SQLite preparation for ${pathname} because it would block cancellation. This inspection requires an asynchronous preparation path; report this Doctor failure and retry after upgrading OpenClaw.`,
    );
    this.name = "SqliteSynchronousPreparationError";
  }
}

export function assertSqliteSynchronousPreparationAllowed(pathname: string): void {
  if (readOnlyWorkerScope.getStore()?.asyncOnly) {
    throw new SqliteSynchronousPreparationError(pathname);
  }
}

/** Reuse child imports until the lifecycle owner closes; reads reacquire source admission. */
export function createSqliteReadOnlyWorkerScope(options?: {
  signal?: AbortSignal;
  deadlineOwnedByCaller?: boolean;
  asyncOnly?: true;
}) {
  const parent = readOnlyWorkerScope.getStore();
  const asyncOnly = options?.asyncOnly ?? parent?.asyncOnly;
  const signal = options?.signal ?? (asyncOnly ? parent?.controller.signal : undefined);
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    busy: false,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
    asyncOnly,
  };
  const abort = () => scope.controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  let closing: Promise<void> | undefined;
  return {
    run<T>(operation: () => T): T {
      return runWithAsyncStore(readOnlyWorkerScope, scope, operation);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        signal?.removeEventListener("abort", abort);
        scope.active = false;
        scope.controller.abort(new SqliteReadOnlyWorkerScopeClosedError());
        materializeErrorStack(scope.controller.signal.reason);
        await Promise.allSettled(scope.pending);
        const closed = await Promise.allSettled([
          scope.worker?.close(),
          scope.releaseReadWorker?.(),
        ]);
        throwSettledAggregate(closed, "SQLite read-only worker scope cleanup failed");
      })();
      return closing;
    },
  };
}

/** Carry the owning readers into callbacks without retaining startup or request authority. */
export function captureSqliteReadOnlyWorkerScope(): <T>(operation: () => T) => T {
  const scope = readOnlyWorkerScope.getStore();
  return (operation) => {
    if (!scope) {
      return readOnlyWorkerScope.getStore() === undefined
        ? operation()
        : readOnlyWorkerScope.exit(operation);
    }
    if (!scope.active) {
      throw new SqliteReadOnlyWorkerScopeClosedError();
    }
    scope.controller.signal.throwIfAborted();
    return runWithAsyncStore(readOnlyWorkerScope, scope, operation);
  };
}
