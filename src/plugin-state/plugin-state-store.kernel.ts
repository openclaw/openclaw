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
  type PluginStateOverflowPolicy,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

const PLUGIN_STATE_EXPIRY_BATCH_ROWS = 1_024;

type PluginStateEntriesTable = OpenClawStateKyselyDatabase["plugin_state_entries"];
type PluginStateStoreDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

export type PluginStateRow = Selectable<PluginStateEntriesTable>;

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
  now: number;
  operation: PluginStateStoreOperation;
  path?: string;
}): number | null {
  if (params.ttlMs == null) {
    return null;
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
  row: PluginStateRow,
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
  ReturnType<typeof prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateRow>>
>();

export function selectPluginStateEntry(
  db: DatabaseSync,
  params: PluginStateEntryLookup,
): PluginStateRow | undefined {
  let query = pluginStateEntryQueries.get(db);
  if (!query) {
    // Retain compilation with the physical connection; keys and expiry stay invocation-local.
    query = prepareSqliteQuerySync<PluginStateEntryLookup, PluginStateRow>(db, (parameter) => {
      const pluginId = parameter((value) => value.pluginId);
      const namespace = parameter((value) => value.namespace);
      const key = parameter((value) => value.key);
      const now = parameter((value) => value.now);
      return getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
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
): IterableIterator<PluginStateRow> {
  return iterateSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
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
): PluginStateRow[] {
  return executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
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

export function deleteExpiredPluginStateEntries(
  db: DatabaseSync,
  now: number,
  scope?: { pluginId: string; namespace: string },
): number {
  const kysely = getPluginStateKysely(db);
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

function countLivePluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
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

export function countLivePluginStateEntries(
  db: DatabaseSync,
  params: { pluginId: string; now: number },
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("plugin_id", "=", params.pluginId)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return coerceRequiredSqliteNumber(row?.count ?? 0);
}

function deleteOldestPluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; protectedKey: string; now: number; limit: number },
): number {
  const kysely = getPluginStateKysely(db);
  const keys = kysely
    .selectFrom("plugin_state_entries")
    .select("entry_key")
    .where("plugin_id", "=", params.pluginId)
    .where("namespace", "=", params.namespace)
    .where("entry_key", "!=", params.protectedKey)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
    .orderBy("created_at", "asc")
    .orderBy("entry_key", "asc")
    .limit(params.limit);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", keys),
  );
  return Number(result.numAffectedRows ?? 0);
}

type PluginStateRetention = {
  namespaceCount: number;
  pluginCount: number;
  nextExpiry: number;
  now: number;
  sweepPending: boolean;
};

export function readPluginStateRetention(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): PluginStateRetention {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => [
        eb.fn.countAll<number | bigint>().as("plugin_count"),
        eb.fn
          .countAll<number | bigint>()
          .filterWhere("namespace", "=", params.namespace)
          .as("namespace_count"),
        eb.fn.min<number | bigint | null>("expires_at").as("next_expiry"),
      ])
      .where("plugin_id", "=", params.pluginId)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return {
    namespaceCount: coerceRequiredSqliteNumber(row?.namespace_count ?? 0),
    pluginCount: coerceRequiredSqliteNumber(row?.plugin_count ?? 0),
    nextExpiry: normalizeSqliteNumber(row?.next_expiry ?? null) ?? Infinity,
    now: params.now,
    sweepPending: true,
  };
}

export function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  protectedKey: string;
  maxPluginEntries: number | undefined;
}): void {
  if (params.overflowPolicy === "reject-new") {
    return;
  }
  const maxPluginEntries = params.maxPluginEntries;
  // A plugin cap no larger than the namespace cap sheds the same oldest prefix.
  if (params.retention || maxPluginEntries === undefined || params.maxEntries < maxPluginEntries) {
    const namespaceCount =
      params.retention?.namespaceCount ??
      countLivePluginStateNamespaceEntries(params.store.db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        now: params.now,
      });
    if (namespaceCount > params.maxEntries) {
      const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        protectedKey: params.protectedKey,
        now: params.now,
        limit: namespaceCount - params.maxEntries,
      });
      if (params.retention) {
        params.retention.namespaceCount -= deleted;
        params.retention.pluginCount -= deleted;
      }
    }
  }

  if (maxPluginEntries === undefined) {
    return;
  }

  const pluginCount =
    params.retention?.pluginCount ??
    countLivePluginStateEntries(params.store.db, {
      pluginId: params.pluginId,
      now: params.now,
    });
  if (pluginCount <= maxPluginEntries) {
    return;
  }

  // Shed only rows from the namespace that grew. Sibling namespaces can hold
  // durable state; if this namespace cannot cover the overflow, fail so the
  // surrounding transaction rolls every insertion and deletion back.
  const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    protectedKey: params.protectedKey,
    now: params.now,
    limit: pluginCount - maxPluginEntries,
  });
  if (params.retention) {
    params.retention.namespaceCount -= deleted;
    params.retention.pluginCount -= deleted;
  }
  // The deletion uses the same live-row predicate and transaction as pluginCount.
  const remainingPluginCount = params.retention?.pluginCount ?? pluginCount - deleted;
  if (remainingPluginCount > maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} exceeds the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

export function assertCanInsertPluginStateEntry(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  maxPluginEntries: number;
}): void {
  if (params.overflowPolicy !== "reject-new") {
    return;
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: params.now,
    });
  if (namespaceCount >= params.maxEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state namespace ${params.namespace} for ${params.pluginId} reached its ${params.maxEntries}-row limit.`,
      path: params.store.path,
    });
  }
  const maxPluginEntries = params.maxPluginEntries;
  const pluginCount =
    params.retention?.pluginCount ??
    countLivePluginStateEntries(params.store.db, {
      pluginId: params.pluginId,
      now: params.now,
    });
  if (pluginCount >= maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} reached the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

export type PluginStateRegisterEntryParams = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  // Migration-only override: eviction orders rows by created_at, so imported
  // legacy rows must keep their original age instead of the import time.
  createdAtMs?: number;
};

/** The caller owns the write transaction, including expiry cleanup and quota eviction. */
export function registerPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStateRegisterEntryParams,
  maxPluginEntries: number,
  retention?: PluginStateRetention,
): void {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    now,
    operation: "register",
    path: store.path,
  });
  // Counts belong to this transaction. Expiry (including sibling rows) or a
  // backward clock invalidates them; ordinary writes update them incrementally.
  if (retention && (now < retention.now || now >= retention.nextExpiry)) {
    Object.assign(retention, readPluginStateRetention(store.db, { ...params, now }));
  }
  if (!retention || retention.sweepPending) {
    const deleted = deleteExpiredPluginStateEntries(store.db, now, params);
    if (retention) {
      retention.sweepPending = deleted === PLUGIN_STATE_EXPIRY_BATCH_ROWS;
    }
  }
  const existing = selectPluginStateEntry(store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    key: params.key,
    now,
  });
  if (!existing) {
    assertCanInsertPluginStateEntry({
      store,
      pluginId: params.pluginId,
      namespace: params.namespace,
      maxEntries: params.maxEntries,
      overflowPolicy: params.overflowPolicy,
      now,
      retention,
      maxPluginEntries,
    });
  }
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      pluginId: params.pluginId,
      namespace: params.namespace,
      key: params.key,
      valueJson: params.valueJson,
      createdAt: params.createdAtMs ?? now,
      expiresAt,
    }),
  );
  if (retention) {
    if (!existing) {
      retention.namespaceCount += 1;
      retention.pluginCount += 1;
    }
    retention.nextExpiry = Math.min(retention.nextExpiry, expiresAt ?? Infinity);
    retention.now = now;
  }
  enforcePostRegisterLimits({
    store,
    pluginId: params.pluginId,
    namespace: params.namespace,
    maxEntries: params.maxEntries,
    overflowPolicy: params.overflowPolicy,
    now,
    protectedKey: params.key,
    retention,
    maxPluginEntries,
  });
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
