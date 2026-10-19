import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";

type Namespace = { pluginId: string; namespace: string };
type Key = Namespace & { key: string };

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
} as const satisfies Record<string, { operation: PluginBlobStoreOperation; message: string }>;

export type PluginBlobReadCommand =
  | { type: "pluginBlob.lookup"; input: Key }
  | { type: "pluginBlob.entries"; input: Namespace };

export type PluginBlobReadReply = { ok: true; sourceAdmitted: true } & (
  | { type: "pluginBlob.lookup"; value: PluginBlobEntry<unknown> | undefined }
  | { type: "pluginBlob.entries"; value: PluginBlobEntryInfo<unknown>[] }
);
