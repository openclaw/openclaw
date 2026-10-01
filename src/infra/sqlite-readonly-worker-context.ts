import { AsyncLocalStorage } from "node:async_hooks";
import type {
  SqliteAuthProfileReadOptions,
  SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";
import type {
  createSqliteReadOnlyWorkerSession,
  SqliteReadOnlyWorkerLaunch,
} from "./sqlite-readonly-worker-session.js";

export type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<SqliteReadOnlyWorkerValue>>;
  deadlineOwnedByCaller: boolean;
  worker?: ReturnType<typeof createSqliteReadOnlyWorkerSession>;
  authWorker?: {
    source: SqliteAuthProfileReadOptions["source"];
    launch: SqliteReadOnlyWorkerLaunch;
    session: ReturnType<typeof createSqliteReadOnlyWorkerSession>;
  };
  authTail: Promise<void>;
};
export const readOnlyWorkerScope = new AsyncLocalStorage<SqliteReadOnlyWorkerScope>();

/** Carry the owning readers into callbacks without retaining startup or request authority. */
export function captureSqliteReadOnlyWorkerScope(): <T>(operation: () => T) => T {
  const scope = readOnlyWorkerScope.getStore();
  return (operation) => {
    if (!scope) {
      return readOnlyWorkerScope.exit(operation);
    }
    if (!scope.active) {
      throw new Error("SQLite read-only worker scope closed");
    }
    scope.controller.signal.throwIfAborted();
    return readOnlyWorkerScope.run(scope, operation);
  };
}
