import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  assertCanInsertPluginStateEntry,
  bindPluginStateEntry,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  enforcePostRegisterLimits,
  getPluginStateKysely,
  hasPluginStateEntry,
  insertPluginStateEntryIfAbsent,
  parseStoredJson,
  resolvePluginStateExpiresAtMs,
  selectPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateRegisterEntryParams,
} from "./plugin-state-store.kernel.js";

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
  maxPluginEntries: number,
): boolean {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
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
  assertCanInsertPluginStateEntry({ maxPluginEntries, store, ...params, now });
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
    maxPluginEntries,
    store,
    ...params,
    now,
    protectedKey: params.key,
  });
  return true;
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
