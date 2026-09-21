import type { Result } from "@openclaw/normalization-core/result";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { deletePluginStateEntry, lookupPluginStateEntry } from "./plugin-state-store.kernel.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  registerPluginStateEntryIfAbsent,
} from "./plugin-state-store.mutations.js";
import { listPluginStateEntries, lookupPluginStateEntries } from "./plugin-state-store.reads.js";
import { registerPluginStateEntry } from "./plugin-state-store.retention.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateStoreError,
} from "./plugin-state-store.types.js";
import {
  prepareKeyedStoreOptions,
  prepareLookupKeys,
  prepareRegisterParams,
  validateKey,
} from "./plugin-state-store.validation.js";

/**
 * Like the blob kernel fixture, exercises real storage policy under the caller's
 * deterministic clock. This is not worker transport/admission or public-facade proof.
 */
export function createPluginStateKernelStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions & { env: NodeJS.ProcessEnv },
): PluginStateKeyedStore<T> {
  const prepared = prepareKeyedStoreOptions(pluginId, options);
  const { namespace, env } = prepared;
  const scope = { pluginId, namespace };
  const database = () => openOpenClawStateDatabase({ env });
  const entry = (key: string, value: T, opts?: { ttlMs?: number }) => ({
    ...prepared,
    ...prepareRegisterParams(key, value, prepared.defaultTtlMs, opts, namespace),
  });
  return {
    async register(key, value, opts) {
      const input = entry(key, value, opts);
      runOpenClawStateWriteTransaction((db) => registerPluginStateEntry(db, input), { env });
    },
    async registerIfAbsent(key, value, opts) {
      const input = entry(key, value, opts);
      return runOpenClawStateWriteTransaction((db) => registerPluginStateEntryIfAbsent(db, input), {
        env,
      });
    },
    async lookup(key) {
      // SAFETY: The caller owns this namespace's serialized JSON type.
      return lookupPluginStateEntry(database(), {
        ...scope,
        key: validateKey(key, "lookup"),
      }) as T | undefined;
    },
    async lookupMany(keys) {
      // SAFETY: Positional outcomes carry the same caller-owned namespace type.
      return lookupPluginStateEntries(database(), {
        ...scope,
        keys: prepareLookupKeys(keys),
      }) as Array<Result<T | undefined, PluginStateStoreError>>;
    },
    async entries() {
      // SAFETY: Entries retain this namespace's caller-owned JSON type.
      return listPluginStateEntries(database(), scope) as PluginStateEntry<T>[];
    },
    async consume(key) {
      const input = { ...scope, key: validateKey(key, "consume") };
      // SAFETY: Consumed values have the same caller-owned namespace type.
      return runOpenClawStateWriteTransaction((db) => consumePluginStateEntry(db, input), {
        env,
      }) as T | undefined;
    },
    async delete(key) {
      const input = { ...scope, key: validateKey(key, "delete") };
      return runOpenClawStateWriteTransaction(({ db }) => deletePluginStateEntry(db, input) > 0, {
        env,
      });
    },
    async clear() {
      runOpenClawStateWriteTransaction(({ db }) => clearPluginStateNamespace(db, scope), { env });
    },
  };
}
