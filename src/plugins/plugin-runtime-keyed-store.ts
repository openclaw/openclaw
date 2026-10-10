import {
  createPluginStateKeyedStore,
  type OpenAsyncKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import type { PluginRecord } from "./registry-types.js";

/** Bind storage and operation code to the same admitted runtime instance before yielding. */
export function createPluginRuntimeKeyedStore<T>(
  record: PluginRecord,
  options: OpenAsyncKeyedStoreOptions,
  assertRuntimeCurrent: () => void,
): Required<PluginStateKeyedStore<T>> {
  if (options.retention === "retained") {
    assertRuntimeCurrent();
  }
  return createPluginStateKeyedStore<T>(
    record.id,
    options,
    assertRuntimeCurrent,
    capturePluginStateOperationModuleSource(getPluginInstance(record), assertRuntimeCurrent),
  );
}
