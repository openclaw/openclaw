import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DatabaseEngineInput } from "./types.js";

export type DatabaseEngineSelection = Readonly<{ input: DatabaseEngineInput }>;

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseEngineSelection"),
  (): { selection?: DatabaseEngineSelection } => ({}),
);

/** An explicit SQLite selection is distinct from an entry point awaiting config. */
export function getDatabaseEngineSelection() {
  return state.selection;
}

/** Boot owns this process-lifetime fact; asynchronous callers never change it. */
export function installDatabaseEngineSelection(selection: DatabaseEngineSelection): void {
  if (state.selection) {
    assertSameDatabaseEngineInput(state.selection.input, selection.input);
    return;
  }
  state.selection = Object.freeze({ input: selection.input && Object.freeze(selection.input) });
}

function assertSameDatabaseEngineInput(
  previous: DatabaseEngineInput,
  next: DatabaseEngineInput,
): void {
  if (previous?.connection !== next?.connection || previous?.schemaPrefix !== next?.schemaPrefix) {
    throw new Error(
      "Database engine selection conflicts with the installed process selection; restart the process to change it",
    );
  }
}
