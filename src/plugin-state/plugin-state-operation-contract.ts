import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type { PluginStateOperationModule } from "./plugin-state-store.native-binding.js";
import type { PreparedKeyedStoreOptions } from "./plugin-state-store.validation.js";

export type PluginStateOperationInput = {
  module: PluginStateOperationModule;
  exportName: string;
  stores: readonly Omit<PreparedKeyedStoreOptions, "env">[];
  writeStores: readonly number[];
  namespaceSnapshots?: Readonly<Record<string, readonly PluginStateReadRow[]>>;
  ifEmpty?: { store: number; value: unknown };
  command: { type: string; input: unknown };
  receiptId: string;
};

export type PluginStateOperationResult = {
  value: unknown;
  validUntil: number | undefined;
  emptyShortcut?: true;
};

export type PluginStateOperationCommit = {
  pluginStateOperation: { receiptId: string };
};
