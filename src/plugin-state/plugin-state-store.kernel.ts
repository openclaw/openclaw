import type { DatabaseSync } from "node:sqlite";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

export const MAX_PLUGIN_STATE_VALUE_BYTES = 1_048_576;
// Outside the historical logical namespace alphabet: legacy stores cannot be reclassified.
export const RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX = "@retained.";

export function isRetainedPluginStateNamespace(namespace: string): boolean {
  return namespace.startsWith(RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX);
}
export const PLUGIN_STATE_EXPIRY_BATCH_ROWS = 1_024;

type PluginStateStoreDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

type PluginStateRow = Selectable<PluginStateStoreDatabase["plugin_state_entries"]>;
export type PluginStateReadRow = Omit<PluginStateRow, "plugin_id" | "namespace">;

export type PluginStateDatabase = {
  db: DatabaseSync;
  path: string;
};

export function createPluginStateError(params: {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  message: string;
  path?: string;
  cause?: unknown;
}): PluginStateStoreError {
  return new PluginStateStoreError(params.message, {
    code: params.code,
    operation: params.operation,
    ...(params.path ? { path: params.path } : {}),
    cause: params.cause,
  });
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

export function parseStoredJson(
  raw: string,
  operation: PluginStateStoreOperation,
  databasePath: string,
): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_CORRUPT",
      operation,
      message: "Plugin state entry contains corrupt JSON.",
      path: databasePath,
      cause: error,
    });
  }
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

export function getPluginStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginStateStoreDatabase>(db);
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

type PluginStateWriteQuery = ReturnType<typeof prepareSqliteQuerySync<PluginStateRow>>;
const pluginStateUpsertQueries = new WeakMap<DatabaseSync, PluginStateWriteQuery>();
const pluginStateInsertIfAbsentQueries = new WeakMap<DatabaseSync, PluginStateWriteQuery>();

export function upsertPluginStateEntry(db: DatabaseSync, row: PluginStateRow): void {
  let query = pluginStateUpsertQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateRow>(db, (parameter) =>
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
        ),
    );
    pluginStateUpsertQueries.set(db, query);
  }
  query(row);
}

export function insertPluginStateEntryIfAbsent(db: DatabaseSync, row: PluginStateRow): boolean {
  let query = pluginStateInsertIfAbsentQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateRow>(db, (parameter) =>
      getPluginStateKysely(db)
        .insertInto("plugin_state_entries")
        .orIgnore()
        .values({
          plugin_id: parameter((value) => value.plugin_id),
          namespace: parameter((value) => value.namespace),
          entry_key: parameter((value) => value.entry_key),
          value_json: parameter((value) => value.value_json),
          created_at: parameter((value) => value.created_at),
          expires_at: parameter((value) => value.expires_at),
        }),
    );
    pluginStateInsertIfAbsentQueries.set(db, query);
  }
  const result = query(row);
  return Number(result.numAffectedRows ?? 0) > 0;
}

type PluginStateEntryLookup = { pluginId: string; namespace: string; key: string; now: number };
const pluginStateEntryQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateReadRow>>
>();
const pluginStateEntryExistsQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateEntryLookup, { entry_key: string }>>
>();

export function hasPluginStateEntry(db: DatabaseSync, params: PluginStateEntryLookup): boolean {
  let query = pluginStateEntryExistsQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateEntryLookup, { entry_key: string }>(
      db,
      (parameter) => {
        const pluginId = parameter((value) => value.pluginId);
        const namespace = parameter((value) => value.namespace);
        const key = parameter((value) => value.key);
        const now = parameter((value) => value.now);
        return getPluginStateKysely(db)
          .selectFrom("plugin_state_entries")
          .select("entry_key")
          .where("plugin_id", "=", pluginId)
          .where("namespace", "=", namespace)
          .where("entry_key", "=", key)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]));
      },
    );
    pluginStateEntryExistsQueries.set(db, query);
  }
  return query(params).rows.length !== 0;
}

export function selectPluginStateEntry(
  db: DatabaseSync,
  params: PluginStateEntryLookup,
): PluginStateReadRow | undefined {
  let query = pluginStateEntryQueries.get(db);
  if (!query) {
    // Retain compilation with the physical connection; keys and expiry stay invocation-local.
    query = prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateReadRow>(db, (parameter) => {
      const pluginId = parameter((value) => value.pluginId);
      const namespace = parameter((value) => value.namespace);
      const key = parameter((value) => value.key);
      const now = parameter((value) => value.now);
      return getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select(["entry_key", "value_json", "created_at", "expires_at"])
        .where("plugin_id", "=", pluginId)
        .where("namespace", "=", namespace)
        .where("entry_key", "=", key)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]));
    });
    pluginStateEntryQueries.set(db, query);
  }
  return query(params).rows[0];
}

export function iteratePluginStateEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): IterableIterator<PluginStateReadRow> {
  return iterateSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("created_at", "asc")
      .orderBy("entry_key", "asc"),
  );
}

export function selectPluginStateEntriesInKeyRange(
  db: DatabaseSync,
  params: {
    pluginId: string;
    namespace: string;
    keyStartInclusive: string;
    keyEndExclusive: string;
    limit: number;
    order: "asc" | "desc";
    now: number;
  },
): PluginStateReadRow[] {
  return executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", ">=", params.keyStartInclusive)
      .where("entry_key", "<", params.keyEndExclusive)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
      .orderBy("entry_key", params.order)
      .limit(params.limit),
  ).rows;
}

export function deletePluginStateEntry(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; key: string },
): number {
  const result = executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "=", params.key),
  );
  return Number(result.numAffectedRows ?? 0);
}

const pluginStateExpiryQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<number, { expires_at: number | bigint | null }>>
>();

export function deleteExpiredPluginStateEntries(
  db: DatabaseSync,
  now: number,
  scope?: { pluginId: string; namespace: string },
): number {
  if (scope && isRetainedPluginStateNamespace(scope.namespace)) {
    return 0;
  }
  const kysely = getPluginStateKysely(db);
  if (scope) {
    let query = pluginStateExpiryQueries.get(db);
    if (!query) {
      query = prepareSqliteQuerySync<number, { expires_at: number | bigint | null }>(
        db,
        (parameter) =>
          kysely
            .selectFrom("plugin_state_entries")
            .select("expires_at")
            .where("expires_at", "is not", null)
            .where(
              "expires_at",
              "<=",
              parameter((value) => value),
            )
            .limit(1),
      );
      pluginStateExpiryQueries.set(db, query);
    }
    // The expiry index can prove there is nothing due without scanning the namespace.
    // Only compilation is retained; expiry is checked in the caller's current transaction.
    if (query(now).rows.length === 0) {
      return 0;
    }
  }
  let expiredEntries = kysely
    .selectFrom("plugin_state_entries")
    .select(["plugin_id", "namespace", "entry_key"])
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", now);
  // Global expiry ordering uses its index; namespace scans must stay unsorted
  // so SQLite never builds an unbounded temporary sort under the write lock.
  expiredEntries = scope
    ? expiredEntries
        .where("plugin_id", "=", scope.pluginId)
        .where("namespace", "=", scope.namespace)
    : expiredEntries.orderBy("expires_at", "asc");
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
      ),
  );
  return Number(result.numAffectedRows ?? 0);
}

type PluginStateNamespaceCountParams = { pluginId: string; namespace: string; now: number };
export type PluginStateCountRow = { count: number | bigint };
const pluginStateNamespaceCountQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateNamespaceCountParams, PluginStateCountRow>>
>();

export function countLivePluginStateNamespaceEntries(
  db: DatabaseSync,
  params: PluginStateNamespaceCountParams,
): number {
  let query = pluginStateNamespaceCountQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateNamespaceCountParams, PluginStateCountRow>(
      db,
      (parameter) =>
        getPluginStateKysely(db)
          .selectFrom("plugin_state_entries")
          .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
          .where(
            "plugin_id",
            "=",
            parameter((value) => value.pluginId),
          )
          .where(
            "namespace",
            "=",
            parameter((value) => value.namespace),
          )
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
    );
    pluginStateNamespaceCountQueries.set(db, query);
  }
  const row = query(params).rows[0];
  return coerceRequiredSqliteNumber(row?.count ?? 0);
}

export function allocatePluginStateNamespaceCreatedAt(
  db: DatabaseSync,
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
  const row = selectPluginStateEntry(store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    key: params.key,
    now: Date.now(),
  });
  return row ? parseStoredJson(row.value_json, "lookup", store.path) : undefined;
}
