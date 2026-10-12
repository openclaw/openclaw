import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import {
  createPluginStateError,
  getPluginStateKysely,
  selectPluginStateEntriesInKeyRange,
  iteratePluginStateEntries,
  parseStoredJson,
  rowToEntry,
  type PluginStateDatabase,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateKeyRange,
} from "./plugin-state-store.types.js";

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
  const rows = iteratePluginStateEntries(store.db, { ...params, now: Date.now() });
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
} & PluginStateKeyRange;

export function validatePluginStateKeyRange(params: PluginStateKeyRangeParams): void {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key-range limit must be a positive safe integer.",
    });
  }
  if (
    typeof params.keyStartInclusive !== "string" ||
    typeof params.keyEndExclusive !== "string" ||
    Buffer.compare(Buffer.from(params.keyStartInclusive), Buffer.from(params.keyEndExclusive)) >= 0
  ) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key range must have an increasing exclusive upper bound.",
    });
  }
  if (params.order !== undefined && params.order !== "asc" && params.order !== "desc") {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "entries",
      message: "Plugin state key-range order must be asc or desc.",
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

type PluginStateBatchParams = { pluginId: string; entriesJson: string; now: number };
const pluginStateBatchQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<PluginStateBatchParams, PluginStateReadRow & { position: number }>(
    db,
    (parameter) =>
      getPluginStateKysely(db)
        .selectFrom((eb) =>
          eb
            .fn<{ key: number; value: string }>("json_each", [
              parameter((value) => value.entriesJson),
            ])
            .as("requested"),
        )
        // Keep requested keys outermost so each row seeks the complete primary key.
        .crossJoin("plugin_state_entries")
        .where(
          "plugin_id",
          "=",
          parameter((value) => value.pluginId),
        )
        .where((eb) =>
          eb(
            "namespace",
            "=",
            eb.fn<string>("json_extract", [eb.ref("requested.value"), eb.val("$[0]")]),
          ),
        )
        .where((eb) =>
          eb(
            "entry_key",
            "=",
            eb.fn<string>("json_extract", [eb.ref("requested.value"), eb.val("$[1]")]),
          ),
        )
        .select([
          "requested.key as position",
          "entry_key",
          "value_json",
          "created_at",
          "expires_at",
        ])
        .where((eb) =>
          eb.or([
            eb("expires_at", "is", null),
            eb(
              "expires_at",
              ">",
              parameter((value) => value.now),
            ),
          ]),
        ),
  ),
);

export function selectPluginStateBatchRows(
  store: PluginStateDatabase,
  entries: readonly { pluginId: string; namespace: string; key: string }[],
  now: number,
): Array<PluginStateReadRow | undefined> {
  const first = entries[0];
  if (!first) {
    return [];
  }
  const rows = new Map(
    pluginStateBatchQuery(store.db)({
      pluginId: first.pluginId,
      entriesJson: JSON.stringify(entries.map(({ namespace, key }) => [namespace, key])),
      now,
    }).rows.map((row) => [row.position, row]),
  );
  return entries.map((_, index) => rows.get(index));
}
