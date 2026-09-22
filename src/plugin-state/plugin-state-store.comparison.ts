import { createHash } from "node:crypto";
import {
  assertCanInsertPluginStateEntry,
  bindPluginStateEntry,
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  enforcePostRegisterLimits,
  parseStoredJson,
  resolvePluginStateExpiresAtMs,
  selectPluginStateEntry,
  upsertPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateRegisterEntryParams,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import type {
  PluginStateCompareResult,
  PluginStateObservation,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

type Key = { pluginId: string; namespace: string; key: string };
export type PluginStatePreparedComparison = Key & { comparison: string } & (
    | { operation: "update"; action: "set"; valueJson: string; ttlMs?: number }
    | { operation: "update" | "delete"; action: "keep" }
    | { operation: "delete"; action: "delete" }
  );
export type PluginStateComparisonLimits = Pick<
  PluginStateRegisterEntryParams,
  "maxEntries" | "overflowPolicy"
> & { maxPluginEntries: number };

const COMPARISON_PATTERN = /^1:([a-f0-9]{64}):([a-f0-9]{64}|-)$/u;

export function validatePluginStateComparison(
  value: string,
  operation: PluginStateStoreOperation,
): string {
  const match = typeof value === "string" ? COMPARISON_PATTERN.exec(value) : null;
  const scope = match?.[1];
  if (!scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      message: "Plugin state comparison must be an observation returned by this store.",
    });
  }
  return scope;
}

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function comparisonScope(storeIdentity: string, key: Key): string {
  return digest([storeIdentity, key.pluginId, key.namespace, key.key]);
}

function observation(
  store: PluginStateDatabase,
  scope: string,
  row: PluginStateReadRow | undefined,
  operation: PluginStateStoreOperation,
): PluginStateObservation<unknown> {
  // Preserve the stored JSON image; caller reserialization can change legacy whitespace/key order.
  const image = row ? digest([row.value_json, row.created_at, row.expires_at]) : "-";
  return {
    value: row ? parseStoredJson(row.value_json, operation, store.path) : undefined,
    comparison: `1:${scope}:${image}`,
  };
}

/** Called after canonical writable admission, with the native owner's recorded database identity. */
export function observePluginStateEntry(
  store: PluginStateDatabase,
  params: Key,
  storeIdentity: string,
): PluginStateObservation<unknown> {
  return observation(
    store,
    comparisonScope(storeIdentity, params),
    selectPluginStateEntry(store.db, { ...params, now: Date.now() }),
    "lookup",
  );
}

/** The caller owns the IMMEDIATE transaction containing comparison, expiry, quotas and mutation. */
export function compareAndApplyPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison & PluginStateComparisonLimits,
  storeIdentity: string,
): PluginStateCompareResult<unknown> {
  const operation = params.operation === "update" ? "register" : "delete";
  const expected = validatePluginStateComparison(params.comparison, operation);
  const scope = comparisonScope(storeIdentity, params);
  if (expected !== scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      path: store.path,
      message: "Plugin state observation belongs to another database, namespace or key.",
    });
  }
  const now = Date.now();
  const row = selectPluginStateEntry(store.db, { ...params, now });
  const current = observation(
    store,
    scope,
    row,
    params.operation === "update" ? "lookup" : "delete",
  );
  if (current.comparison !== params.comparison) {
    return { status: "conflict", current };
  }
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
  if (!row) {
    assertCanInsertPluginStateEntry({ ...params, store, now });
  }
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    now,
    operation: "register",
    path: store.path,
  });
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      ...params,
      createdAt: now,
      expiresAt,
    }),
  );
  enforcePostRegisterLimits({ ...params, store, now, protectedKey: params.key });
  return { status: "applied" };
}
