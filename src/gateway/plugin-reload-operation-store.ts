import {
  listConfigMachineStateAsync,
  readConfigMachineStateAsync,
  upsertPluginReloadOperationAsync,
} from "../state/config-machine-state-async.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  parsePluginReloadOperation,
  PLUGIN_RELOAD_OPERATION_KEY_PREFIX,
  type PluginReloadOperation,
} from "./plugin-reload-operation-store.types.js";

export type {
  PluginReloadContinuation,
  PluginReloadOperation,
} from "./plugin-reload-operation-store.types.js";

export async function readPluginReloadOperation(
  id: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<PluginReloadOperation | undefined> {
  const value = await readConfigMachineStateAsync<unknown>(
    PLUGIN_RELOAD_OPERATION_KEY_PREFIX + id,
    options,
  );
  if (value === undefined) {
    return undefined;
  }
  const operation = parsePluginReloadOperation(value);
  if (operation.id !== id) {
    throw new Error("Plugin reload operation identity does not match its storage key");
  }
  return operation;
}

/** Newest updates first; live operations are never removed by receipt retention. */
export async function listPluginReloadOperations(
  options: OpenClawStateDatabaseOptions = {},
): Promise<PluginReloadOperation[]> {
  const rows = await listConfigMachineStateAsync(PLUGIN_RELOAD_OPERATION_KEY_PREFIX, options);
  return rows
    .map(({ key, value }) => {
      const operation = parsePluginReloadOperation(value);
      if (key !== PLUGIN_RELOAD_OPERATION_KEY_PREFIX + operation.id) {
        throw new Error("Plugin reload operation identity does not match its storage key");
      }
      return operation;
    })
    .toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id),
    );
}

/** Await successful acceptance before interrupting a run or reloading a plugin. */
export async function savePluginReloadOperation(
  operation: PluginReloadOperation,
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  await upsertPluginReloadOperationAsync(operation, options);
}
