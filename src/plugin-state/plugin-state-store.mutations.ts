import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readPreparedPluginStateNativeBinding } from "./plugin-state-native-binding-codec.js";
import type {
  PluginStateNativeBindingDeletion,
  PluginStateNativeBindingPlan,
} from "./plugin-state-native-binding.types.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  bindPluginStateEntry,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  deletePluginStateEntryRow,
  getPluginStateKysely,
  insertPluginStateEntryIfAbsent,
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
  db: EngineConnection,
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
  // The conflict predicate also replaces an expired key beyond the bounded sweep.
  const inserted = insertPluginStateEntryIfAbsent(
    store.db,
    bindPluginStateEntry({ ...params, createdAt: now, expiresAt }),
    now,
  );
  if (!inserted) {
    return false;
  }
  // Capacity failure rolls back the insert and its staged receipt together.
  assertCanInsertPluginStateEntry({ store, ...params, now, additionalEntries: 0 });
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
  const row = deletePluginStateEntryRow(store.db, { ...params, now: Date.now() });
  if (!row) {
    return undefined;
  }
  return parseStoredJson(row.value_json, "consume", store.path);
}
