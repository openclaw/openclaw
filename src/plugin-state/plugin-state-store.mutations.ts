import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  bindPluginStateEntry,
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  getPluginStateKysely,
  hasPluginStateEntry,
  insertPluginStateEntryIfAbsent,
  isRetainedPluginStateNamespace,
  parseStoredJson,
  resolvePluginStateExpiresAtMs,
  selectPluginStateEntry,
  upsertPluginStateEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import {
  assertCanInsertPluginStateEntry,
  enforcePostRegisterLimits,
  type PluginStateRegisterEntryParams,
} from "./plugin-state-store.retention.js";
import type { PluginStateMoveEntries } from "./plugin-state-store.types.js";

export function clearPluginStateNamespace(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string },
): void {
  executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace),
  );
}

/** The caller owns the transaction containing admission, expiry cleanup, and insertion. */
export function registerPluginStateEntryIfAbsent(
  store: PluginStateDatabase,
  params: Omit<PluginStateRegisterEntryParams, "createdAtMs">,
): boolean {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    namespace: params.namespace,
    now,
    operation: "register",
    path: store.path,
  });
  deleteExpiredPluginStateEntries(store.db, now, params);
  const existing = hasPluginStateEntry(store.db, { ...params, now });
  if (existing) {
    return false;
  }
  // The exact expired key can lie beyond the namespace cleanup batch.
  deletePluginStateEntry(store.db, params);
  assertCanInsertPluginStateEntry({ store, ...params, now });
  const inserted = insertPluginStateEntryIfAbsent(
    store.db,
    bindPluginStateEntry({
      pluginId: params.pluginId,
      namespace: params.namespace,
      key: params.key,
      valueJson: params.valueJson,
      createdAt: now,
      expiresAt,
    }),
  );
  if (!inserted) {
    return false;
  }
  enforcePostRegisterLimits({
    store,
    ...params,
    now,
    protectedKey: params.key,
  });
  return true;
}

/** Apply a prepared update after the caller has read and checked the current row. */
export function updatePluginStateEntry(
  store: PluginStateDatabase,
  params: Omit<PluginStateRegisterEntryParams, "createdAtMs">,
  now: number,
  exists: boolean,
): void {
  if (!exists) {
    assertCanInsertPluginStateEntry({ ...params, store, now });
  }
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    namespace: params.namespace,
    now,
    operation: "register",
    path: store.path,
  });
  upsertPluginStateEntry(store.db, bindPluginStateEntry({ ...params, createdAt: now, expiresAt }));
  enforcePostRegisterLimits({ ...params, store, now, protectedKey: params.key });
}

/** The caller owns the transaction containing the authoritative comparison and deletion. */
export function deletePluginStateEntryIfEqual(
  store: PluginStateDatabase,
  params: {
    pluginId: string;
    namespace: string;
    key: string;
    expected: string | number | boolean | null;
  },
): boolean {
  const row = selectPluginStateEntry(store.db, { ...params, now: Date.now() });
  if (!row || parseStoredJson(row.value_json, "delete", store.path) !== params.expected) {
    return false;
  }
  return deletePluginStateEntry(store.db, params) > 0;
}

/** Decode inside the caller's write transaction so corrupt JSON rolls back deletion. */
export function consumePluginStateEntry(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string; key: string },
): unknown {
  const row = selectPluginStateEntry(store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    key: params.key,
    now: Date.now(),
  });
  if (!row) {
    return undefined;
  }
  deletePluginStateEntry(store.db, params);
  return parseStoredJson(row.value_json, "consume", store.path);
}

export type PluginStateMoveEntriesParams = {
  pluginId: string;
  namespace: string;
  sourceNamespace: string;
  entries: PluginStateMoveEntries["entries"];
};

/** The worker owns the transaction; no payload decoding or plugin callback occurs here. */
export function movePluginStateEntries(
  store: PluginStateDatabase,
  params: PluginStateMoveEntriesParams,
): number {
  if (
    !isRetainedPluginStateNamespace(params.namespace) ||
    isRetainedPluginStateNamespace(params.sourceNamespace) ||
    params.sourceNamespace === params.namespace
  ) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Plugin state moves require a bounded source and a retained destination.",
    });
  }
  const now = Date.now();
  let moved = 0;
  for (const entry of params.entries) {
    const source = {
      pluginId: params.pluginId,
      namespace: params.sourceNamespace,
      key: entry.sourceKey,
    };
    const row = selectPluginStateEntry(store.db, { ...source, now });
    if (!row) {
      continue;
    }
    if (row.expires_at !== null) {
      throw createPluginStateError({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "register",
        message: "Cannot move live expiring plugin state into a retained store.",
        path: store.path,
      });
    }
    insertPluginStateEntryIfAbsent(store.db, {
      plugin_id: params.pluginId,
      namespace: params.namespace,
      entry_key: entry.targetKey,
      value_json: row.value_json,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
    moved += deletePluginStateEntry(store.db, source);
  }
  return moved;
}
