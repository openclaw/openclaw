import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  pluginBlobClearInDatabase,
  pluginBlobDeleteInDatabase,
  pluginBlobDeleteExpiredInDatabase,
  pluginBlobDeleteExpiredKeyInDatabase,
  pluginBlobEntriesInDatabase,
  pluginBlobLookupInDatabase,
  pluginBlobRegisterInDatabase,
  pluginBlobRegisterIfAbsentInDatabase,
} from "./plugin-blob-store.sqlite.js";
import type { OpenBlobStoreOptions, PluginBlobStore } from "./plugin-blob-store.types.js";

/** Deterministic clocks and query budgets exercise the same kernels the worker consumes. */
export function createPluginBlobKernelStore<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions & { env: NodeJS.ProcessEnv },
): PluginBlobStore<TMetadata> {
  const { namespace, env } = options;
  const scope = { pluginId, namespace, env };
  const write = <T>(operation: (db: DatabaseSync) => T): T =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { env });
  const prepared = (
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ) => ({
    ...scope,
    key,
    bytes,
    metadataJson: JSON.stringify(metadata),
    maxEntries: options.maxEntries,
    maxBytesPerNamespace: options.maxBytesPerNamespace,
    overflowPolicy: options.overflowPolicy ?? "evict-oldest",
    ttlMs: opts?.ttlMs ?? options.defaultTtlMs,
  });
  return {
    async register(key, bytes, metadata, opts) {
      write((db) => pluginBlobRegisterInDatabase(db, prepared(key, bytes, metadata, opts)));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      return write((db) =>
        pluginBlobRegisterIfAbsentInDatabase(db, prepared(key, bytes, metadata, opts)),
      );
    },
    async lookup(key) {
      return pluginBlobLookupInDatabase<TMetadata>(openOpenClawStateDatabase({ env }).db, {
        ...scope,
        key,
      });
    },
    async entries() {
      return pluginBlobEntriesInDatabase<TMetadata>(openOpenClawStateDatabase({ env }).db, scope);
    },
    async delete(key) {
      return write((db) => pluginBlobDeleteInDatabase(db, { ...scope, key }));
    },
    async deleteExpiredKey(key) {
      return write((db) => pluginBlobDeleteExpiredKeyInDatabase<TMetadata>(db, { ...scope, key }));
    },
    async deleteExpired() {
      return write((db) => pluginBlobDeleteExpiredInDatabase<TMetadata>(db, scope));
    },
    async clear() {
      write((db) => pluginBlobClearInDatabase(db, scope));
    },
  };
}
