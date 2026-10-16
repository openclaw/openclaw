import { toUSVString } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { hasOpenClawStateTablesBeyondStartupCheckpoint } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  PluginStateOperationInput,
  PluginStateOperationResult,
} from "./plugin-state-operation-contract.js";
import { isMissingPluginStateTableError } from "./plugin-state-store.database.js";
import {
  deletePluginStateEntry,
  isRetainedPluginStateNamespace,
  rowToEntry,
  selectPluginStateEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import { listPluginStateEntries, selectPluginStateBatchRows } from "./plugin-state-store.reads.js";
import {
  readPluginStateRetention,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import type {
  PluginStateEntry,
  PluginStateOperationDefinitions,
  PluginStateOperationHandler,
  PluginStateOperationTransaction,
} from "./plugin-state-store.types.js";
import {
  invalidInput,
  prepareRegisterParams,
  validateKey,
} from "./plugin-state-store.validation.js";

/** One native invocation owns its read view, quota facts, and facade lifetime. */
export function executePluginStateOperation(
  initialStore: PluginStateDatabase | undefined,
  input: PluginStateOperationInput,
  handler: PluginStateOperationHandler<PluginStateOperationDefinitions>,
): PluginStateOperationResult {
  let store = initialStore;
  let active = true;
  let validUntil: number | undefined;
  const writable = new Set(input.writeStores);
  const readNative = <T>(read: (database: PluginStateDatabase) => T, empty: () => T): T => {
    if (!store) {
      return empty();
    }
    try {
      return read(store);
    } catch (error) {
      if (
        writable.size === 0 &&
        isMissingPluginStateTableError(error) &&
        !hasOpenClawStateTablesBeyondStartupCheckpoint(store.db)
      ) {
        store = undefined;
        return empty();
      }
      throw error;
    }
  };
  const views = new Map<
    string,
    {
      entries: Map<string, PluginStateEntry<unknown> | undefined>;
      scanned: boolean;
      retention?: ReturnType<typeof readPluginStateRetention>;
    }
  >();
  const requireScope = (index: number, write = false) => {
    if (!active) {
      throw invalidInput("Plugin state transaction has already returned.");
    }
    const options = Number.isSafeInteger(index) ? input.stores[index] : undefined;
    if (!options || (write && (!writable.has(index) || !store))) {
      throw invalidInput("Plugin state operation has no authority for this store.");
    }
    const identity = JSON.stringify([options.pluginId, options.namespace]);
    let view = views.get(identity);
    if (!view) {
      view = { entries: new Map(), scanned: !store };
      views.set(identity, view);
    }
    return { options, view };
  };
  const observe = (entry: PluginStateEntry<unknown> | undefined) => {
    if (entry?.expiresAt !== undefined) {
      validUntil = Math.min(validUntil ?? Infinity, entry.expiresAt);
    }
    return entry;
  };
  const live = (entry: PluginStateEntry<unknown> | undefined) =>
    entry?.expiresAt !== undefined && entry.expiresAt <= Date.now() ? undefined : entry;
  const read = (index: number, rawKey: string) => {
    const { options, view } = requireScope(index);
    const key = toUSVString(validateKey(rawKey, "lookup"));
    if (!view.entries.has(key) && !view.scanned && store) {
      const row = readNative(
        (database) => selectPluginStateEntry(database.db, { ...options, key, now: Date.now() }),
        () => undefined,
      );
      view.entries.set(key, row ? rowToEntry(row, "lookup", store.path) : undefined);
    }
    return observe(live(view.entries.get(key)));
  };
  const transaction: PluginStateOperationTransaction = {
    lookup(index: number, key: string) {
      return read(index, key)?.value;
    },
    lookupMany<T>(keys: readonly { store: number; key: string }[]) {
      if (!active) {
        throw invalidInput("Plugin state transaction has already returned.");
      }
      if (keys.length > 10_000) {
        throw invalidInput("Plugin state operations accept at most 10000 lookup keys.");
      }
      const missing = new Map<string, { index: number; key: string }>();
      for (const { store: index, key: rawKey } of keys) {
        const { options, view } = requireScope(index);
        const key = toUSVString(validateKey(rawKey, "lookup"));
        if (!view.scanned && !view.entries.has(key)) {
          missing.set(JSON.stringify([options.namespace, key]), { index, key });
        }
      }
      const requested = [...missing.values()];
      if (store && requested.length > 0) {
        const rows = readNative(
          (database) =>
            selectPluginStateBatchRows(
              database,
              requested.map(({ index, key }) => ({
                ...requireScope(index).options,
                key,
              })),
              Date.now(),
            ),
          () => [],
        );
        for (const [position, { index, key }] of requested.entries()) {
          const row = rows[position];
          requireScope(index).view.entries.set(
            key,
            row ? rowToEntry(row, "lookup", store.path) : undefined,
          );
        }
      }
      // SAFETY: Positional results retain the plugin's selected namespace value types.
      return keys.map(({ store: index, key }) => read(index, key)?.value as T | undefined);
    },
    entries<T>(index: number) {
      const { options, view } = requireScope(index);
      if (!view.scanned && store) {
        const entries = readNative(
          (database) => listPluginStateEntries(database, options),
          () => [],
        );
        view.entries = new Map(entries.map((entry) => [entry.key, entry]));
        view.scanned = true;
      }
      const entries = [...view.entries.values()].flatMap((entry) => {
        const current = observe(live(entry));
        return current ? [current] : [];
      });
      entries.sort(
        (a, b) =>
          a.createdAt - b.createdAt || Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
      );
      // SAFETY: The plugin owns the captured namespace's JSON value type.
      return entries as PluginStateEntry<T>[];
    },
    set(index, rawKey, value, options) {
      const { options: scope, view } = requireScope(index, true);
      const prepared = prepareRegisterParams(
        rawKey,
        value,
        scope.defaultTtlMs,
        options,
        scope.namespace,
      );
      const key = toUSVString(prepared.key);
      const retained = isRetainedPluginStateNamespace(scope.namespace);
      const existing = !retained && read(index, key) !== undefined;
      const now = Date.now();
      if (!view.retention && !retained) {
        view.retention = view.scanned
          ? {
              namespaceCount: [...view.entries.values()].filter((entry) => live(entry)).length,
              nextExpiry: [...view.entries.values()].reduce(
                (expiry, entry) => Math.min(expiry, live(entry)?.expiresAt ?? Infinity),
                Infinity,
              ),
              now,
              sweepPending: true,
            }
          : readPluginStateRetention(store!.db, { ...scope, now });
      }
      registerPluginStateEntry(
        store!,
        { ...scope, ...prepared, key, createdAtMs: now },
        view.retention,
        existing,
        (evicted) => {
          for (const evictedKey of evicted) {
            view.entries.set(evictedKey, undefined);
          }
        },
        now,
      );
      const expiresAt = prepared.ttlMs === undefined ? undefined : now + prepared.ttlMs;
      view.entries.set(
        key,
        observe({
          key,
          value: JSON.parse(prepared.valueJson) as unknown,
          createdAt: now,
          expiresAt,
        }),
      );
    },
    delete(index, rawKey) {
      const { options, view } = requireScope(index, true);
      const key = toUSVString(validateKey(rawKey, "delete"));
      const existing = view.retention ? read(index, key) !== undefined : false;
      const deleted = deletePluginStateEntry(store!.db, { ...options, key }) > 0;
      if (existing && deleted && view.retention) {
        view.retention.namespaceCount -= 1;
      }
      view.entries.set(key, undefined);
      return deleted;
    },
  };
  try {
    const value = handler(input.command, transaction);
    if (isPromiseLike(value)) {
      void Promise.resolve(value).catch(() => {});
      throw invalidInput("Plugin state operation handlers must return synchronously.");
    }
    return { value, validUntil };
  } finally {
    active = false;
  }
}
