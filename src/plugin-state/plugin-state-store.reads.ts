import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQuerySync, sqliteStringSet } from "../infra/kysely-sync.js";
import {
  createPluginStateError,
  getPluginStateKysely,
  selectPluginStateEntriesInKeyRange,
  iteratePluginStateEntries,
  parseStoredJson,
  rowToEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import { PluginStateStoreError, type PluginStateEntry } from "./plugin-state-store.types.js";

export function lookupPluginStateEntries(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string; keys: readonly string[] },
): Array<Result<unknown, PluginStateStoreError>> {
  const now = Date.now();
  const rows = executeSqliteQuerySync(
    store.db,
    getPluginStateKysely(store.db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key", "value_json"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", sqliteStringSet(params.keys))
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)])),
  ).rows;
  const values = new Map(rows.map((row) => [row.entry_key, row.value_json]));
  return params.keys.map((key): Result<unknown, PluginStateStoreError> => {
    // Match node:sqlite text binding, including lone UTF-16 surrogates.
    const raw = values.get(toUSVString(key));
    try {
      return ok(raw === undefined ? undefined : parseStoredJson(raw, "lookup", store.path));
    } catch (error) {
      // Let ordered readers stop before a later corrupt value, just as with lookup.
      if (error instanceof PluginStateStoreError && error.code === "PLUGIN_STATE_CORRUPT") {
        return err(error);
      }
      throw error;
    }
  });
}

export function listPluginStateEntries(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string },
): PluginStateEntry<unknown>[] {
  const rows = iteratePluginStateEntries(store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    now: Date.now(),
  });
  const entries: PluginStateEntry<unknown>[] = [];
  let decodeFailure: { error: unknown } | undefined;
  for (const row of rows) {
    if (decodeFailure) {
      continue;
    }
    try {
      entries.push(rowToEntry(row, "entries", store.path));
    } catch (error) {
      // Finish the SQL read so a later step failure still precedes JSON errors.
      decodeFailure = { error };
    }
  }
  if (decodeFailure) {
    throw decodeFailure.error;
  }
  return entries;
}

export type PluginStateKeyRangeParams = {
  pluginId: string;
  namespace: string;
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
};

export function validatePluginStateKeyRange(params: PluginStateKeyRangeParams): void {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key-range limit must be a positive safe integer.",
    });
  }
  if (params.keyStartInclusive >= params.keyEndExclusive) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key range must have an increasing exclusive upper bound.",
    });
  }
}

export function listPluginStateEntriesInKeyRange(
  store: PluginStateDatabase,
  params: PluginStateKeyRangeParams,
): PluginStateEntry<unknown>[] {
  return selectPluginStateEntriesInKeyRange(store.db, {
    ...params,
    order: params.order ?? "asc",
    now: Date.now(),
  }).map((row) => rowToEntry(row, "entries", store.path));
}
