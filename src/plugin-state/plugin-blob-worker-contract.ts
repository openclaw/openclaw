import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { BlobWriteParams } from "./plugin-blob-store.sqlite.js";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";

type Namespace = { pluginId: string; namespace: string };
type Key = Namespace & { key: string };
type Write = Omit<BlobWriteParams, "env">;

export type PluginBlobWorkerOperations = {
  "pluginBlob.register": { input: Write; output: void };
  "pluginBlob.registerIfAbsent": { input: Write; output: boolean };
  "pluginBlob.delete": { input: Key; output: boolean };
  "pluginBlob.deleteExpiredKey": {
    input: Key;
    output: PluginBlobEntryInfo<unknown> | undefined;
  };
  "pluginBlob.deleteExpired": {
    input: Namespace;
    output: PluginBlobEntryInfo<unknown>[];
  };
  "pluginBlob.clear": { input: Namespace; output: void };
};

export const pluginBlobWorkerOperations = {
  "pluginBlob.register": {
    operation: "register",
    message: "Failed to register plugin blob entry.",
  },
  "pluginBlob.registerIfAbsent": {
    operation: "register",
    message: "Failed to register plugin blob entry.",
  },
  "pluginBlob.delete": { operation: "delete", message: "Failed to delete plugin blob entry." },
  "pluginBlob.deleteExpiredKey": {
    operation: "sweep",
    message: "Failed to delete expired plugin blob.",
  },
  "pluginBlob.deleteExpired": {
    operation: "sweep",
    message: "Failed to delete expired plugin blobs.",
  },
  "pluginBlob.clear": { operation: "clear", message: "Failed to clear plugin blob entries." },
} as const satisfies Record<
  keyof PluginBlobWorkerOperations,
  { operation: PluginBlobStoreOperation; message: string }
>;

export function isPluginBlobWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<PluginBlobWorkerOperations> {
  return Object.hasOwn(pluginBlobWorkerOperations, command.type);
}

export type PluginBlobReadCommand =
  | { type: "pluginBlob.lookup"; input: Key }
  | { type: "pluginBlob.entries"; input: Namespace };

export type PluginBlobReadReply =
  | {
      ok: true;
      type: "pluginBlob.lookup";
      sourceAdmitted: true;
      value: PluginBlobEntry<unknown> | undefined;
    }
  | {
      ok: true;
      type: "pluginBlob.entries";
      sourceAdmitted: true;
      value: PluginBlobEntryInfo<unknown>[];
    };

export function isPluginBlobReadCommand(command: unknown): command is PluginBlobReadCommand {
  return (
    isRecord(command) &&
    isRecord(command.input) &&
    typeof command.input.pluginId === "string" &&
    typeof command.input.namespace === "string" &&
    (command.type === "pluginBlob.entries" ||
      (command.type === "pluginBlob.lookup" && typeof command.input.key === "string"))
  );
}
