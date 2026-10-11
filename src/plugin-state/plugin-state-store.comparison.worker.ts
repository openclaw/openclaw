import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  createPluginStateObservation,
  pluginStateComparisonScope,
  validatePluginStateComparison,
} from "./plugin-state-observation.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  getPluginStateKysely,
  resolvePluginStateExpiresAtMs,
  selectPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import { updatePluginStateEntry } from "./plugin-state-store.mutations.js";
import {
  enforcePostRegisterLimits,
  type PluginStateRegisterEntryParams,
} from "./plugin-state-store.retention.js";
import type {
  PluginStateCompareResult,
  PluginStateComparisonCondition,
  PluginStateObservation,
} from "./plugin-state-store.types.js";

type Key = { pluginId: string; namespace: string; key: string };
export type PluginStatePreparedComparison = Key & {
  comparison: string;
  conditions?: readonly PluginStateComparisonCondition[];
} & (
    | { operation: "update"; action: "set"; valueJson: string; ttlMs?: number }
    | { operation: "update" | "delete"; action: "keep" }
    | { operation: "delete"; action: "delete" }
  );
export type PluginStateComparisonLimits = Pick<
  PluginStateRegisterEntryParams,
  "maxEntries" | "overflowPolicy"
>;

/** Called after canonical writable admission, with the native owner's recorded database identity. */
export function observePluginStateEntry(
  store: PluginStateDatabase,
  params: Key,
  storeIdentity: string,
): PluginStateObservation<unknown> & { row?: PluginStateReadRow } {
  const row = selectPluginStateEntry(store.db, { ...params, now: Date.now() });
  return {
    ...createPluginStateObservation(
      store.path,
      pluginStateComparisonScope(storeIdentity, params),
      row,
      "lookup",
    ),
    row,
  };
}

function validateComparisonScope(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison,
  storeIdentity: string,
): string {
  const operation = params.operation === "update" ? "register" : "delete";
  const expected = validatePluginStateComparison(params.comparison, operation);
  const scope = pluginStateComparisonScope(storeIdentity, params);
  if (expected !== scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      path: store.path,
      message: "Plugin state observation belongs to another database, namespace or key.",
    });
  }
  return scope;
}

function applyComparedEntry(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison & PluginStateComparisonLimits,
  now: number,
  row: PluginStateReadRow | undefined,
): { status: "applied" | "unchanged" } | undefined {
  if (params.action === "keep") {
    if (params.operation === "update") {
      deleteExpiredPluginStateEntries(store.db, now, params);
    }
    return { status: "unchanged" };
  }
  if (!row) {
    if (params.action === "delete") {
      return { status: "unchanged" };
    }
    deleteExpiredPluginStateEntries(store.db, now, params);
    updatePluginStateEntry(store, params, now, false);
    return { status: "applied" };
  }
  const kysely = getPluginStateKysely(store.db);
  // Compare storage bytes and metadata, not caller JSON serialization.
  if (params.action === "delete") {
    const result = executeSqliteQuerySync(
      store.db,
      kysely
        .deleteFrom("plugin_state_entries")
        .where("plugin_id", "=", params.pluginId)
        .where("namespace", "=", params.namespace)
        .where("entry_key", "=", params.key)
        .where("value_json", "=", row.value_json)
        .where("created_at", "=", row.created_at)
        .where("expires_at", row.expires_at === null ? "is" : "=", row.expires_at)
        .returning(["plugin_id", "namespace", "entry_key"]),
    );
    if (result.rows.length === 0) {
      return undefined;
    }
    pluginStatePublication.stageDeletions(store.db, result.rows);
    return { status: "applied" };
  }
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    namespace: params.namespace,
    now,
    operation: "register",
    path: store.path,
  });
  const result = executeSqliteQuerySync(
    store.db,
    kysely
      .updateTable("plugin_state_entries")
      .set({ value_json: params.valueJson, created_at: now, expires_at: expiresAt })
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key)
      .where("value_json", "=", row.value_json)
      .where("created_at", "=", row.created_at)
      .where("expires_at", row.expires_at === null ? "is" : "=", row.expires_at)
      .returningAll(),
  );
  if (result.rows.length === 0) {
    return undefined;
  }
  for (const current of result.rows) {
    pluginStatePublication.stagePostimage(store.db, current);
  }
  deleteExpiredPluginStateEntries(store.db, now, params);
  enforcePostRegisterLimits({ ...params, store, now, protectedKey: params.key });
  return { status: "applied" };
}

/** The caller owns the IMMEDIATE transaction containing comparison, expiry, quotas and mutation. */
export function compareAndApplyPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison & PluginStateComparisonLimits,
  storeIdentity: string,
): PluginStateCompareResult<unknown> {
  const scope = validateComparisonScope(store, params, storeIdentity);
  const now = Date.now();
  // Native binding transactions can change rows without a plugin-state receipt.
  // Compare against this transaction's row so conflicts always converge, including keep.
  const row = selectPluginStateEntry(store.db, { ...params, now });
  const current = createPluginStateObservation(
    store.path,
    scope,
    row,
    params.operation === "update" ? "lookup" : "delete",
  );
  if (current.comparison !== params.comparison) {
    return { status: "conflict", current };
  }
  for (const condition of params.conditions ?? []) {
    const conditionKey = { pluginId: params.pluginId, ...condition };
    if (
      validatePluginStateComparison(
        condition.comparison,
        params.operation === "update" ? "register" : "delete",
      ) !== pluginStateComparisonScope(storeIdentity, conditionKey)
    ) {
      throw createPluginStateError({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: params.operation === "update" ? "register" : "delete",
        path: store.path,
        message: "Plugin state condition belongs to another database, namespace or key.",
      });
    }
    if (
      observePluginStateEntry(store, conditionKey, storeIdentity).comparison !==
      condition.comparison
    ) {
      return { status: "conflict", current };
    }
  }
  const result = applyComparedEntry(store, params, now, row);
  if (result) {
    return result;
  }
  return {
    status: "conflict",
    current: createPluginStateObservation(
      store.path,
      scope,
      selectPluginStateEntry(store.db, { ...params, now }),
      params.operation === "update" ? "lookup" : "delete",
    ),
  };
}
