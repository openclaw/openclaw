import {
  createPluginStateObservation,
  pluginStateComparisonScope,
  validatePluginStateComparison,
} from "./plugin-state-observation.js";
import {
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  selectPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import { updatePluginStateEntry } from "./plugin-state-store.mutations.js";
import type { PluginStateRegisterEntryParams } from "./plugin-state-store.retention.js";
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
): { status: "applied" | "unchanged" } {
  if (params.operation === "delete") {
    return {
      status:
        params.action === "delete" && row && deletePluginStateEntry(store.db, params) > 0
          ? "applied"
          : "unchanged",
    };
  }
  deleteExpiredPluginStateEntries(store.db, now, params);
  if (params.action === "keep") {
    return { status: "unchanged" };
  }
  updatePluginStateEntry(store, params, now, row !== undefined);
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
  return applyComparedEntry(store, params, now, row);
}
