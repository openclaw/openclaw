import type { Result } from "@openclaw/normalization-core/result";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type {
  PluginStateOperationInput,
  PluginStateOperationResult,
} from "./plugin-state-operation-contract.js";
import type {
  PluginStateComparisonLimits,
  PluginStatePreparedComparison,
} from "./plugin-state-store.comparison.worker.js";
import type { PluginStateSequencedJournalParams } from "./plugin-state-store.journal.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type { PluginStateMoveEntriesParams } from "./plugin-state-store.moves.worker.js";
import type { PluginStateRegisterEntryParams } from "./plugin-state-store.retention.js";
import type {
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyRangeParams,
  PluginStateObservation,
  PluginStateStoreErrorCode,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import type { PluginStateWorkerFailure } from "./plugin-state-worker-errors.js";
import type { RuntimeHealthClearSelection } from "./runtime-health-records.js";

type Namespace = { pluginId: string; namespace: string };
type Key = Namespace & { key: string };
type Register = Omit<PluginStateRegisterEntryParams, "createdAtMs">;

export type PluginStateWorkerRequests = {
  "pluginState.loadNamespace": {
    input: Namespace & { maxBytes: number };
    output: PluginStateReadRow[] | undefined;
  };
  "pluginState.executeOperation": {
    input: PluginStateOperationInput;
    output: PluginStateOperationResult;
  };
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
    output: PluginStateObservation<unknown> & { row?: PluginStateReadRow };
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
  "pluginState.replaceEntry": { input: Register; output: void };
  "pluginState.replace": {
    input: Omit<Register, "key" | "valueJson" | "ttlMs"> & {
      entries: readonly Pick<Register, "key" | "valueJson" | "ttlMs">[];
    };
    output: void;
  };
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
  "pluginState.clearRuntimeHealth": {
    input: Namespace & { processId: number; selection: RuntimeHealthClearSelection };
    output: void;
  };
};

export type PluginStateWorkerOperations = {
  [Request in keyof PluginStateWorkerRequests]: {
    input: PluginStateWorkerRequests[Request]["input"] extends undefined
      ? undefined
      : PluginStateWorkerRequests[Request]["input"] & {
          sessionEntryCurrentSources?: readonly SessionEntryCurrentSource[];
        };
    output: Result<PluginStateWorkerRequests[Request]["output"], PluginStateWorkerFailure>;
  };
};

type PluginStateReadType =
  | "pluginState.lookup"
  | "pluginState.lookupMany"
  | "pluginState.entries"
  | "pluginState.entriesInKeyRange"
  | "pluginState.count";

export type PluginStateWriteOperations = Omit<PluginStateWorkerOperations, PluginStateReadType>;

export type PluginStateReadCommand = SqliteWorkerCommand<
  Pick<PluginStateWorkerOperations, PluginStateReadType>
>;
export type PluginStateReadResult = {
  [Type in PluginStateReadType]: {
    type: Type;
    result: PluginStateWorkerOperations[Type]["output"];
  };
}[PluginStateReadType];

export function isPluginStateReadCommand(command: {
  type: PropertyKey;
}): command is PluginStateReadCommand {
  return (
    command.type === "pluginState.lookup" ||
    command.type === "pluginState.lookupMany" ||
    command.type === "pluginState.entries" ||
    command.type === "pluginState.entriesInKeyRange" ||
    command.type === "pluginState.count"
  );
}

function readFailure<
  const Operation extends PluginStateStoreOperation,
  const Message extends string,
>(operation: Operation, message: Message) {
  return { operation, code: "PLUGIN_STATE_READ_FAILED", message } as const;
}

function writeFailure<
  const Operation extends PluginStateStoreOperation,
  const Message extends string,
>(operation: Operation, message: Message) {
  return { operation, code: "PLUGIN_STATE_WRITE_FAILED", message } as const;
}

export const pluginStateWorkerOperations = {
  "pluginState.loadNamespace": readFailure("entries", "Failed to load plugin state namespace."),
  "pluginState.executeOperation": writeFailure(
    "register",
    "Failed to execute plugin state operation.",
  ),
  "pluginState.appendJournal": writeFailure(
    "register",
    "Failed to register sequenced plugin state journal entry.",
  ),
  "pluginState.entriesInKeyRange": readFailure(
    "entries",
    "Failed to list plugin state entries by key range.",
  ),
  "pluginState.moveEntries": writeFailure("register", "Failed to move plugin state entries."),
  "pluginState.observe": readFailure("lookup", "Failed to observe plugin state entry."),
  "pluginState.compareUpdate": writeFailure("register", "Failed to update plugin state entry."),
  "pluginState.compareDelete": writeFailure(
    "delete",
    "Failed to conditionally delete plugin state entry.",
  ),
  "pluginState.register": writeFailure("register", "Failed to register plugin state entry."),
  "pluginState.replace": writeFailure("register", "Failed to replace plugin state namespace."),
  "pluginState.replaceEntry": writeFailure("register", "Failed to replace plugin state entry."),
  "pluginState.registerIfAbsent": writeFailure(
    "register",
    "Failed to register plugin state entry.",
  ),
  "pluginState.deleteIfEqual": writeFailure(
    "delete",
    "Failed to conditionally delete plugin state entry.",
  ),
  "pluginState.lookup": readFailure("lookup", "Failed to read plugin state entry."),
  "pluginState.lookupMany": readFailure("lookup", "Failed to read plugin state entries."),
  "pluginState.consume": readFailure("consume", "Failed to consume plugin state entry."),
  "pluginState.delete": writeFailure("delete", "Failed to delete plugin state entry."),
  "pluginState.entries": readFailure("entries", "Failed to list plugin state entries."),
  "pluginState.count": readFailure("count", "Failed to count plugin state entries."),
  "pluginState.clear": writeFailure("clear", "Failed to clear plugin state namespace."),
  "pluginState.clearRuntimeHealth": writeFailure(
    "clear",
    "Failed to clear runtime health records.",
  ),
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
}): command is SqliteWorkerCommand<PluginStateWriteOperations> {
  return (
    !isPluginStateReadCommand(command) && Object.hasOwn(pluginStateWorkerOperations, command.type)
  );
}
