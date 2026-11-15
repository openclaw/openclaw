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
  (): { selection?: DatabaseEngineSelection; readOnly: boolean; preparingWriter?: boolean } => ({
    readOnly: false,
  }),
);
const maintenance = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseEngineMaintenanceSelection"),
  () => new AsyncLocalStorage<DatabaseEngineSelection>(),
);

/** An explicit SQLite selection is distinct from an entry point awaiting config. */
export function getDatabaseEngineSelection() {
  const scoped = maintenance.getStore();
  const selected = scoped ?? state.selection;
  return selected && state.readOnly && scoped?.access !== "read-write"
    ? {
        ...selected,
        access: state.preparingWriter ? ("writer-preparation" as const) : ("read-only" as const),
      }
    : selected;
}

/** Candidate startup owns this gate; activation must present its actual writer custody. */
export function setDatabaseEngineReadOnlyAdmission(readOnly: true): void;
export function setDatabaseEngineReadOnlyAdmission(readOnly: false, assertWriter: () => void): void;
export function setDatabaseEngineReadOnlyAdmission(
  readOnly: boolean,
  assertWriter?: () => void,
): void {
  if (!readOnly) {
    if (!assertWriter) {
      throw new Error("Database write activation requires current Gateway ownership");
    }
    assertWriter();
  }
  state.readOnly = readOnly;
  state.preparingWriter = false;
}

/** Writer-capable sockets are prepared under enforced read transactions, never toggled in place. */
export function prepareDatabaseEngineWriterAdmission(assertWriter: () => void): void {
  assertWriter();
  state.readOnly = true;
  state.preparingWriter = true;
}

export function isDatabaseEngineReadOnlyAdmission(): boolean {
  return (
    maintenance.getStore()?.access !== "read-write" &&
    (state.readOnly ||
      getDatabaseEngineSelection()?.access === "read-only" ||
      getDatabaseEngineSelection()?.access === "writer-preparation")
  );
}

export function isDatabaseEnginePhysicalReadOnlyAdmission(): boolean {
  if (maintenance.getStore()?.access === "read-write") {
    return false;
  }
  return (
    (state.readOnly && !state.preparingWriter) ||
    getDatabaseEngineSelection()?.access === "read-only"
  );
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
  return selection?.effectiveEngines[family] === "postgres"
    ? selection.access === "read-only" && selection.postgres
      ? { ...selection.postgres, readOnly: true }
      : selection.access === "writer-preparation" && selection.postgres
        ? { ...selection.postgres, readOnlySchema: true }
        : selection.postgres
    : undefined;
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
    previous.postgres?.connectionEnvKey !== next.postgres?.connectionEnvKey ||
    previous.postgres?.readOnly !== next.postgres?.readOnly ||
    previous.postgres?.ownership !== next.postgres?.ownership ||
    listDatabaseEngineStores().some(
      ({ id }) => previous.effectiveEngines[id] !== next.effectiveEngines[id],
    )
  ) {
    throw new Error(
      "Database engine selection conflicts with the installed process selection; restart the process to change it",
    );
  }
}
