import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import type { StateDatabaseCoordinatorRuntime } from "./state-database-coordinator.js";

/** Resolved host facts for the canonical shared-state owner, never authority. */
export type SqliteWorkerStateContext = {
  environment: {
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_SUPERVISOR_MODE?: "external";
  };
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
  existingSchemaPath?: string;
};

// Source hosts and built backends can load separate module copies in one Worker.
const stateContexts = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerStateContext"),
  () => new AsyncLocalStorage<SqliteWorkerStateContext>(),
);

export function runWithSqliteWorkerStateContext<T>(
  context: SqliteWorkerStateContext,
  operation: () => T,
): T {
  return stateContexts.run(context, () =>
    context.existingSchemaPath === undefined
      ? operation()
      : withExistingOpenClawStateSchema({ path: context.existingSchemaPath }, operation),
  );
}

export function getSqliteWorkerStateContext(): SqliteWorkerStateContext {
  const context = stateContexts.getStore();
  if (!context) {
    throw new Error("Shared-state SQLite requires captured host context");
  }
  return context;
}
