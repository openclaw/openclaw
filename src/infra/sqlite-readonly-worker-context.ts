import { AsyncLocalStorage } from "node:async_hooks";
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
export const readOnlyWorkerScope = new AsyncLocalStorage<SqliteReadOnlyWorkerScope>();

export class SqliteReadOnlyWorkerScopeClosedError extends Error {
  readonly code = "SQLITE_READONLY_WORKER_SCOPE_CLOSED";

  constructor() {
    super("SQLite read-only worker scope closed");
  }
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
    return readOnlyWorkerScope.getStore() === scope
      ? operation()
      : readOnlyWorkerScope.run(scope, operation);
  };
}
