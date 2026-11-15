import { deletePluginStateEntry, type PluginStateDatabase } from "./plugin-state-store.kernel.js";
import { listPluginStateEntries } from "./plugin-state-store.reads.js";
import {
  selectRuntimeHealthClearKeys,
  type RuntimeHealthClearSelection,
} from "./runtime-health-records.js";

type RuntimeHealthClearParams = {
  pluginId: string;
  namespace: string;
  processId: number;
  selection: RuntimeHealthClearSelection;
};

function findRuntimeHealthClearKeys(store: PluginStateDatabase, params: RuntimeHealthClearParams) {
  return selectRuntimeHealthClearKeys(
    listPluginStateEntries(store, params),
    params.processId,
    params.selection,
  );
}

export function hasRuntimeHealthEntriesToClear(
  store: PluginStateDatabase,
  params: RuntimeHealthClearParams,
): boolean {
  return findRuntimeHealthClearKeys(store, params).length > 0;
}

/** The caller owns the transaction spanning current-row selection and deletion. */
export function clearRuntimeHealthEntries(
  store: PluginStateDatabase,
  params: RuntimeHealthClearParams,
): void {
  for (const key of findRuntimeHealthClearKeys(store, params)) {
    deletePluginStateEntry(store.db, { ...params, key });
  }
}
