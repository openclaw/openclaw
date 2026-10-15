import type { PluginStateOperationModule } from "./plugin-state-store.native-binding.js";
import type { PreparedKeyedStoreOptions } from "./plugin-state-store.validation.js";

export type PluginStateOperationInput = {
  module: PluginStateOperationModule;
  exportName: string;
  stores: readonly Omit<PreparedKeyedStoreOptions, "env">[];
  writeStores: readonly number[];
  command: { type: string; input: unknown };
  receiptId: string;
};

export type PluginStateOperationResult = {
  value: unknown;
  validUntil: number | undefined;
};

export type PluginStateOperationCommit = {
  pluginStateOperation: { receiptId: string; validUntil: number | undefined };
};
