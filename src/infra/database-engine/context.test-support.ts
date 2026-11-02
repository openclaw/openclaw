import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DatabaseEngineSelection } from "./context.js";

export function resetDatabaseEngineSelectionForTest(): void {
  const state = resolveGlobalSingleton(
    Symbol.for("openclaw.databaseEngineSelection"),
    (): { selection?: DatabaseEngineSelection } => ({}),
  );
  delete state.selection;
}
