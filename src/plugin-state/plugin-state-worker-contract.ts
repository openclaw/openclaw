import type { Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type {
  PluginStateComparisonLimits,
  PluginStatePreparedComparison,
} from "./plugin-state-store.comparison.js";
import type { PluginStateSequencedJournalParams } from "./plugin-state-store.journal.js";
import type { PluginStateMoveEntriesParams } from "./plugin-state-store.mutations.js";
import type { PluginStateKeyRangeParams } from "./plugin-state-store.reads.js";
import type { PluginStateRegisterEntryParams } from "./plugin-state-store.retention.js";
import type {
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateObservation,
  PluginStateStoreErrorCode,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import type { PluginStateWorkerFailure } from "./plugin-state-worker-errors.js";

type Namespace = { pluginId: string; namespace: string };
type Key = Namespace & { key: string };
type Register = Omit<PluginStateRegisterEntryParams, "createdAtMs">;

export type PluginStateWorkerRequests = {
  "pluginState.appendJournal": {
    input: PluginStateSequencedJournalParams;
    output: number;
  };
  "pluginState.entriesInKeyRange": {
    input: PluginStateKeyRangeParams;
    output: PluginStateEntry<unknown>[];
  };
  "pluginState.moveEntries": {
    input: PluginStateMoveEntriesParams;
    output: number;
  };
  "pluginState.observe": {
    input: Key;
    output: PluginStateObservation<unknown>;
  };
  "pluginState.compareUpdate": {
    input: PluginStatePreparedComparison & PluginStateComparisonLimits & { operation: "update" };
    output: PluginStateCompareResult<unknown>;
  };
  "pluginState.compareDelete": {
    input: PluginStatePreparedComparison & PluginStateComparisonLimits & { operation: "delete" };
    output: PluginStateCompareResult<unknown>;
  };
  "pluginState.register": { input: Register; output: void };
  "pluginState.registerIfAbsent": {
    input: Register;
    output: boolean;
  };
  "pluginState.deleteIfEqual": {
    input: Key & { expected: string | number | boolean | null };
    output: boolean;
  };
  "pluginState.lookup": { input: Key; output: unknown };
  "pluginState.lookupMany": {
    input: Namespace & { keys: readonly string[] };
    output: Array<Result<unknown, PluginStateWorkerFailure>>;
  };
  "pluginState.consume": { input: Key; output: unknown };
  "pluginState.delete": { input: Key; output: boolean };
  "pluginState.entries": {
    input: Namespace;
    output: PluginStateEntry<unknown>[];
  };
  "pluginState.count": { input: Namespace; output: number };
  "pluginState.clear": { input: Namespace; output: void };
  "pluginState.sweep": { input: undefined; output: number };
};

export type PluginStateWorkerOperations = {
  [Key in keyof PluginStateWorkerRequests]: {
    input: PluginStateWorkerRequests[Key]["input"];
    output: Result<PluginStateWorkerRequests[Key]["output"], PluginStateWorkerFailure>;
  };
};

export const pluginStateWorkerOperations = {
  "pluginState.appendJournal": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to register sequenced plugin state journal entry.",
  },
  "pluginState.entriesInKeyRange": {
    operation: "entries",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to list plugin state entries by key range.",
  },
  "pluginState.moveEntries": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to move plugin state entries.",
  },
  "pluginState.observe": {
    operation: "lookup",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to observe plugin state entry.",
  },
  "pluginState.compareUpdate": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to update plugin state entry.",
  },
  "pluginState.compareDelete": {
    operation: "delete",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to conditionally delete plugin state entry.",
  },
  "pluginState.register": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to register plugin state entry.",
  },
  "pluginState.registerIfAbsent": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to register plugin state entry.",
  },
  "pluginState.deleteIfEqual": {
    operation: "delete",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to conditionally delete plugin state entry.",
  },
  "pluginState.lookup": {
    operation: "lookup",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to read plugin state entry.",
  },
  "pluginState.lookupMany": {
    operation: "lookup",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to read plugin state entries.",
  },
  "pluginState.consume": {
    operation: "consume",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to consume plugin state entry.",
  },
  "pluginState.delete": {
    operation: "delete",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to delete plugin state entry.",
  },
  "pluginState.entries": {
    operation: "entries",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to list plugin state entries.",
  },
  "pluginState.count": {
    operation: "count",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to count plugin state entries.",
  },
  "pluginState.clear": {
    operation: "clear",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to clear plugin state namespace.",
  },
  "pluginState.sweep": {
    operation: "sweep",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to sweep expired plugin state entries.",
  },
} as const satisfies Record<
  keyof PluginStateWorkerOperations,
  {
    operation: PluginStateStoreOperation;
    code: PluginStateStoreErrorCode;
    message: string;
  }
>;

/** Selects the plugin-state branch of the shared actor's typed command union. */
export function isPluginStateWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<PluginStateWorkerOperations> {
  return Object.hasOwn(pluginStateWorkerOperations, command.type);
}
