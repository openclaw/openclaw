import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { readPreparedPluginStateNativeBinding } from "./plugin-state-native-binding-codec.js";
import type {
  PluginStateNativeBindingDeletion,
  PluginStateNativeBindingPlan,
} from "./plugin-state-native-binding.types.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
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
import { prepareRegisterParams } from "./plugin-state-store.validation.js";

/** The executing worker owns the transaction containing this exact native binding predicate. */
export function deletePluginStateNativeBinding(
  store: PluginStateDatabase,
  plan: PluginStateNativeBindingPlan,
): PluginStateNativeBindingDeletion {
  const row = selectPluginStateEntry(store.db, { ...plan, now: Date.now() });
  if (plan.predicate.kind === "absent") {
    return { status: row ? "conflict" : "absent" };
  }
  const raw = row
    ? asOptionalRecord(parseStoredJson(row.value_json, "delete", store.path))
    : undefined;
  const parsed = readPreparedPluginStateNativeBinding(plan, raw);
  const { lease, ...value } = parsed ?? {};
  if (
    !raw ||
    lease?.token !== plan.predicate.token ||
    lease.expiresAt <= Date.now() ||
    !isDeepStrictEqual(value, plan.predicate.value)
  ) {
    return { status: "conflict" };
  }
  if (deletePluginStateEntry(store.db, plan) === 0) {
    return { status: "conflict" };
  }
  return { status: "deleted", value: raw };
}

/** Restore the removed payload only while its key remains absent; a successor always wins. */
export function restorePluginStateNativeBinding(
  store: PluginStateDatabase,
  plan: PluginStateNativeBindingPlan,
  removedValue: Record<string, unknown>,
): boolean {
  if (plan.predicate.kind !== "leased") {
    return false;
  }
  const restored = {
    ...removedValue,
    lease: { token: plan.predicate.token, expiresAt: Date.now() + plan.staleMs },
  };
  return registerPluginStateEntryIfAbsent(store, {
    ...plan,
    ...prepareRegisterParams(plan.key, restored, plan.ttlMs),
  });
}

export function clearPluginStateNamespace(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string },
): void {
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .returning(["plugin_id", "namespace", "entry_key"]),
  );
  pluginStatePublication.stageDeletions(db, result.rows);
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
    bindPluginStateEntry({ ...params, createdAt: now, expiresAt }),
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
  const row = selectPluginStateEntry(store.db, { ...params, now: Date.now() });
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
    isRetainedPluginStateNamespace(params.sourceNamespace)
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
