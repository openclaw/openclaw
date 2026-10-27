import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { Expression, Selectable } from "kysely";
import { jsonPathValue } from "../infra/database-engine/json-values.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { createPluginStateError, parseStoredJson } from "./plugin-state-error.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import type {
  PluginStateEntry,
  PluginStateKeyRangeParams,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

export { createPluginStateError, parseStoredJson } from "./plugin-state-error.js";

export const MAX_PLUGIN_STATE_VALUE_BYTES = 1_048_576;
export const PLUGIN_STATE_NAMESPACE_MAX_ROWS = 10_000;
export const PLUGIN_STATE_NAMESPACE_MAX_BYTES = 8 * 1024 * 1024;
// Outside the historical logical namespace alphabet: legacy stores cannot be reclassified.
export const RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX = "@retained.";

export function isRetainedPluginStateNamespace(namespace: string): boolean {
  return namespace.startsWith(RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX);
}
export const PLUGIN_STATE_EXPIRY_BATCH_ROWS = 1_024;

type PluginStateStoreDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

export type PluginStateRow = Selectable<PluginStateStoreDatabase["plugin_state_entries"]>;
export type PluginStateReadRow = Omit<PluginStateRow, "plugin_id" | "namespace">;

export type PluginStateDatabase = {
  db: EngineConnection;
  path: string;
};

export function pluginStateNamespaceRowBytes(row: PluginStateReadRow): number {
  return 128 + 2 * (row.entry_key.length + row.value_json.length);
}

export function resolvePluginStateExpiresAtMs(params: {
  ttlMs: number | undefined;
  namespace?: string;
  now: number;
  operation: PluginStateStoreOperation;
  path?: string;
}): number | null {
  if (params.ttlMs == null) {
    return null;
  }
  if (params.namespace && isRetainedPluginStateNamespace(params.namespace)) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: params.operation,
      message: "Retained plugin state does not accept a TTL.",
      path: params.path,
    });
  }
  const expiresAt = resolveExpiresAtMsFromDurationMs(params.ttlMs, { nowMs: params.now });
  if (expiresAt === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: params.operation,
      message: "Plugin state ttlMs cannot produce a valid expiry timestamp.",
      ...(params.path ? { path: params.path } : {}),
    });
  }
  return expiresAt;
}

export function rowToEntry(
  row: PluginStateReadRow,
  operation: PluginStateStoreOperation,
  databasePath: string,
): PluginStateEntry<unknown> {
  const expiresAt = normalizeSqliteNumber(row.expires_at);
  return {
    key: row.entry_key,
    value: parseStoredJson(row.value_json, operation, databasePath),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

export function getPluginStateKysely(db: EngineConnection) {
  return getNodeSqliteKysely<PluginStateStoreDatabase>(db);
}

export function selectLivePluginStateRows(
  db: EngineConnection,
  params: {
    pluginId: string | Expression<string>;
    namespace?: string | Expression<string>;
    now: number | Expression<number>;
  },
) {
  let query = getPluginStateKysely(db)
    .selectFrom("plugin_state_entries")
    .where("plugin_id", "=", params.pluginId);
  if (params.namespace !== undefined) {
    query = query.where("namespace", "=", params.namespace);
  }
  return query.where((eb) =>
    eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]),
  );
}

export function assertPluginStateKey(
  db: EngineConnection | boolean,
  key: string,
  operation: PluginStateStoreOperation,
): void {
  // Memory reads carry the already selected engine fact instead of opening a connection.
  if ((typeof db === "boolean" ? db : isPostgresSqlConnection(db)) && key.includes("\0")) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      message: "PostgreSQL plugin state keys cannot contain NUL characters.",
    });
  }
}

export function bindPluginStateEntry(params: {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  createdAt: number;
  expiresAt: number | null;
}): PluginStateRow {
  return {
    plugin_id: params.pluginId,
    namespace: params.namespace,
    entry_key: params.key,
    value_json: params.valueJson,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

const pluginStateUpsertQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<PluginStateRow, PluginStateRow>(db, (parameter) =>
    getPluginStateKysely(db)
      .insertInto("plugin_state_entries")
      .values({
        plugin_id: parameter((value) => value.plugin_id),
        namespace: parameter((value) => value.namespace),
        entry_key: parameter((value) => value.entry_key),
        value_json: parameter((value) => value.value_json),
        created_at: parameter((value) => value.created_at),
        expires_at: parameter((value) => value.expires_at),
      })
      .onConflict((conflict) =>
        conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
          value_json: (eb) => eb.ref("excluded.value_json"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        }),
      )
      .returningAll(),
  ),
);

export function upsertPluginStateEntry(db: EngineConnection, row: PluginStateRow): void {
  assertPluginStateKey(db, row.entry_key, "register");
  const result = pluginStateUpsertQuery(db)(row);
  for (const current of result.rows) {
    pluginStatePublication.stagePostimage(db, current);
  }
}

const pluginStateInsertIfAbsentQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<PluginStateRow & { now: number }, PluginStateRow>(db, (parameter) =>
    getPluginStateKysely(db)
      .insertInto("plugin_state_entries")
      .values({
        plugin_id: parameter((value) => value.plugin_id),
        namespace: parameter((value) => value.namespace),
        entry_key: parameter((value) => value.entry_key),
        value_json: parameter((value) => value.value_json),
        created_at: parameter((value) => value.created_at),
        expires_at: parameter((value) => value.expires_at),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["plugin_id", "namespace", "entry_key"])
          .doUpdateSet({
            value_json: (eb) => eb.ref("excluded.value_json"),
            created_at: (eb) => eb.ref("excluded.created_at"),
            expires_at: (eb) => eb.ref("excluded.expires_at"),
          })
          .where(
            "plugin_state_entries.expires_at",
            "<=",
            parameter((value) => value.now),
          ),
      )
      .returningAll(),
  ),
);

export function insertPluginStateEntryIfAbsent(
  db: EngineConnection,
  row: PluginStateRow,
  now: number,
): boolean {
  assertPluginStateKey(db, row.entry_key, "register");
  const result = pluginStateInsertIfAbsentQuery(db)({ ...row, now });
  for (const current of result.rows) {
    pluginStatePublication.stagePostimage(db, current);
  }
  return result.rows.length > 0;
}

type PluginStateEntryLookup = { pluginId: string; namespace: string; key: string; now: number };
const pluginStateEntryExistsQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<PluginStateEntryLookup, { entry_key: string }>(db, (parameter) => {
    const pluginId = parameter((value) => value.pluginId);
    const namespace = parameter((value) => value.namespace);
    const key = parameter((value) => value.key);
    const now = parameter((value) => value.now);
    return selectLivePluginStateRows(db, { pluginId, namespace, now })
      .select("entry_key")
      .where("entry_key", "=", key);
  }),
);

export function hasPluginStateEntry(db: EngineConnection, params: PluginStateEntryLookup): boolean {
  assertPluginStateKey(db, params.key, "lookup");
  return pluginStateEntryExistsQuery(db)(params).rows.length !== 0;
}

// Retain compilation with the physical connection; keys and expiry stay invocation-local.
const pluginStateEntryQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateReadRow>(db, (parameter) => {
    const pluginId = parameter((value) => value.pluginId);
    const namespace = parameter((value) => value.namespace);
    const key = parameter((value) => value.key);
    const now = parameter((value) => value.now);
    return selectLivePluginStateRows(db, { pluginId, namespace, now })
      .select(["entry_key", "value_json", "created_at", "expires_at"])
      .where("entry_key", "=", key);
  }),
);

export function selectPluginStateEntry(
  db: EngineConnection,
  params: PluginStateEntryLookup,
): PluginStateReadRow | undefined {
  assertPluginStateKey(db, params.key, "lookup");
  return pluginStateEntryQuery(db)(params).rows[0];
}

export function iteratePluginStateEntries(
  db: EngineConnection,
  params: { pluginId: string; namespace: string; now: number },
): IterableIterator<PluginStateReadRow> {
  return iterateSqliteQuerySync(
    db,
    selectLivePluginStateRows(db, params)
      .select(["entry_key", "value_json", "created_at", "expires_at"])
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc"),
  );
}

export function selectPluginStateEntriesInKeyRange(
  db: EngineConnection,
  params: PluginStateKeyRangeParams & { order: "asc" | "desc"; now: number },
): PluginStateReadRow[] {
  assertPluginStateKey(db, params.keyStartInclusive, "entries");
  assertPluginStateKey(db, params.keyEndExclusive, "entries");
  let query = selectLivePluginStateRows(db, params)
    .select(["entry_key", "value_json", "created_at", "expires_at"])
    .where("entry_key", ">=", params.keyStartInclusive)
    .where("entry_key", "<", params.keyEndExclusive);
  const filter = params.valueFilter;
  if (filter) {
    query = query.where((eb) =>
      eb(jsonPathValue(db, eb.ref("value_json"), eb.val(filter.path)), "=", filter.equals),
    );
  }
  return executeSqliteQuerySync(db, query.orderBy("entry_key", params.order).limit(params.limit))
    .rows;
}

export function deletePluginStateEntry(
  db: EngineConnection,
  params: { pluginId: string; namespace: string; key: string },
): number {
  return deletePluginStateEntryRow(db, params) ? 1 : 0;
}

export function deletePluginStateEntryRow(
  db: EngineConnection,
  params: { pluginId: string; namespace: string; key: string; now?: number },
) {
  assertPluginStateKey(db, params.key, "delete");
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key)
      .$if(params.now !== undefined, (query) =>
        query.where((eb) =>
          eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now!)]),
        ),
      )
      .returning(["plugin_id", "namespace", "entry_key"])
      .returning((eb) =>
        (params.now === undefined ? eb.val("") : eb.ref("value_json")).as("value_json"),
      ),
  );
  pluginStatePublication.stageDeletions(db, result.rows);
  return result.rows[0];
}

const pluginStateExpiryQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<number, { expires_at: number | bigint | null }>(db, (parameter) =>
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select("expires_at")
      .where("expires_at", "is not", null)
      .where(
        "expires_at",
        "<=",
        parameter((value) => value),
      )
      .limit(1),
  ),
);

export function deleteExpiredPluginStateEntries(
  db: EngineConnection,
  now: number,
  scope: { pluginId: string; namespace: string },
  hasExpiredEntries = false,
): number {
  if (isRetainedPluginStateNamespace(scope.namespace)) {
    return 0;
  }
  const kysely = getPluginStateKysely(db);
  // The expiry index can prove there is nothing due without scanning the namespace.
  // Reuse expiry already observed by the namespace aggregate in this transaction.
  if (!hasExpiredEntries && pluginStateExpiryQuery(db)(now).rows.length === 0) {
    return 0;
  }
  // Leave namespace scans unsorted to avoid an unbounded sort under the write lock.
  const expiredEntries = kysely
    .selectFrom("plugin_state_entries")
    .select(["plugin_id", "namespace", "entry_key"])
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", now)
    .where("plugin_id", "=", scope.pluginId)
    .where("namespace", "=", scope.namespace);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where((expression) =>
        expression(
          expression.refTuple("plugin_id", "namespace", "entry_key"),
          "in",
          expiredEntries
            .limit(PLUGIN_STATE_EXPIRY_BATCH_ROWS)
            .$asTuple("plugin_id", "namespace", "entry_key"),
        ),
      )
      .returning(["plugin_id", "namespace", "entry_key"]),
  );
  pluginStatePublication.stageDeletions(db, result.rows);
  return result.rows.length;
}

type PluginStateNamespaceCountParams = { pluginId: string; namespace: string; now: number };
export type PluginStateCountRow = { count: number | bigint };
const pluginStateNamespaceCountQuery = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQuerySync<PluginStateNamespaceCountParams, PluginStateCountRow>(db, (parameter) =>
    selectLivePluginStateRows(db, {
      pluginId: parameter((value) => value.pluginId),
      namespace: parameter((value) => value.namespace),
      now: parameter((value) => value.now),
    }).select((eb) => eb.fn.countAll<number | bigint>().as("count")),
  ),
);

export function countLivePluginStateNamespaceEntries(
  db: EngineConnection,
  params: PluginStateNamespaceCountParams,
): number {
  const row = pluginStateNamespaceCountQuery(db)(params).rows[0];
  return coerceRequiredSqliteNumber(row?.count ?? 0);
}

export function allocatePluginStateNamespaceCreatedAt(
  db: EngineConnection,
  params: { pluginId: string; namespace: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("max_created_at"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace),
  );
  const previous = normalizeSqliteNumber(row?.max_created_at ?? null);
  const next = previous === undefined ? params.now : Math.max(params.now, previous + 1);
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("Plugin state namespace append order exhausted safe integer range");
  }
  return next;
}

export function lookupPluginStateEntry(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string; key: string },
): unknown {
  const row = selectPluginStateEntry(store.db, { ...params, now: Date.now() });
  return row ? parseStoredJson(row.value_json, "lookup", store.path) : undefined;
}
