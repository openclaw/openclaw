import { AsyncContext } from "../shared/async-context.js";
import { runWithAsyncStore } from "../shared/async-store.js";
import { throwSettledAggregate } from "./error-graph-internal.js";
import type { SqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session-types.js";

export type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  deadlineOwnedByCaller: boolean;
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

/** Reuse child imports until the lifecycle owner closes; reads reacquire source admission. */
export function createSqliteReadOnlyWorkerScope(options?: {
  signal: AbortSignal;
  deadlineOwnedByCaller: boolean;
}) {
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    busy: false,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
  };
  const abort = () => scope.controller.abort(options?.signal.reason);
  options?.signal.addEventListener("abort", abort, { once: true });
  if (options?.signal.aborted) {
    abort();
  }
  let closing: Promise<void> | undefined;
  return {
    run<T>(operation: () => T): T {
      return runWithAsyncStore(readOnlyWorkerScope, scope, operation);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        options?.signal.removeEventListener("abort", abort);
        scope.active = false;
        scope.controller.abort(new SqliteReadOnlyWorkerScopeClosedError());
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
