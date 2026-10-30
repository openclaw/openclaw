import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { listDatabaseEngineStores } from "./registry.js";
import type {
  DatabaseEngineFamily,
  DatabaseEngineInput,
  DatabaseEngineSelection,
} from "./types.js";
export type { DatabaseEngineSelection } from "./types.js";

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseEngineSelection"),
  (): { selection?: DatabaseEngineSelection } => ({}),
);
const maintenance = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseEngineMaintenanceSelection"),
  () => new AsyncLocalStorage<DatabaseEngineSelection>(),
);

/** An explicit SQLite selection is distinct from an entry point awaiting config. */
export function getDatabaseEngineSelection() {
  return maintenance.getStore() ?? state.selection;
}

/** Config-driven operations reuse only their own captured selection, never a running Gateway's. */
export function getScopedDatabaseEngineSelection() {
  return maintenance.getStore();
}

/** Offline transitions keep source and target work scoped without changing the running Gateway. */
export function withDatabaseEngineSelection<T>(
  selection: DatabaseEngineSelection,
  run: () => T,
): T {
  return maintenance.run(selection, run);
}

/** Each store consumes its boot-selected family without resolving configuration again. */
export function getDatabaseEngineInput(family: DatabaseEngineFamily): DatabaseEngineInput {
  const selection = getDatabaseEngineSelection();
  return selection?.effectiveEngines[family] === "postgres" ? selection.postgres : undefined;
}

/** Boot owns this process-lifetime fact; asynchronous callers never change it. */
export function installDatabaseEngineSelection(selection: DatabaseEngineSelection): void {
  if (state.selection) {
    assertSameDatabaseEngineSelection(state.selection, selection);
    return;
  }
  Object.freeze(selection.effectiveEngines);
  if (selection.postgres) {
    Object.freeze(selection.postgres);
  }
  state.selection = Object.freeze(selection);
}

function assertSameDatabaseEngineSelection(
  previous: DatabaseEngineSelection,
  next: DatabaseEngineSelection,
): void {
  if (
    previous.postgres?.connection !== next.postgres?.connection ||
    previous.postgres?.schemaPrefix !== next.postgres?.schemaPrefix ||
    listDatabaseEngineStores().some(
      ({ id }) => previous.effectiveEngines[id] !== next.effectiveEngines[id],
    )
  ) {
    throw new Error(
      "Database engine selection conflicts with the installed process selection; restart the process to change it",
    );
  }
}
