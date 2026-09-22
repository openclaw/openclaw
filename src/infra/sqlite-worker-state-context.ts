import { AsyncLocalStorage } from "node:async_hooks";
import type { StateDatabaseCoordinatorRuntime } from "./state-database-coordinator.js";

/** Resolved host facts for the canonical shared-state owner, never authority. */
export type SqliteWorkerStateContext = {
  environment: {
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_SUPERVISOR_MODE?: "external";
  };
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
};

const stateContexts = new AsyncLocalStorage<SqliteWorkerStateContext>();

export function runWithSqliteWorkerStateContext<T>(
  context: SqliteWorkerStateContext,
  operation: () => T,
): T {
  return stateContexts.run(context, operation);
}

export function getSqliteWorkerStateContext(): SqliteWorkerStateContext {
  const context = stateContexts.getStore();
  if (!context) {
    throw new Error("Shared-state SQLite requires captured host context");
  }
  return context;
}
