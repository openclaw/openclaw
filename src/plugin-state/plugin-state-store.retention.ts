import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import {
  bindPluginStateEntry,
  countLivePluginStateNamespaceEntries,
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  getPluginStateKysely,
  hasPluginStateEntry,
  isRetainedPluginStateNamespace,
  PLUGIN_STATE_EXPIRY_BATCH_ROWS,
  resolvePluginStateExpiresAtMs,
  upsertPluginStateEntry,
  type PluginStateCountRow,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import type { PluginStateOverflowPolicy } from "./plugin-state-store.types.js";

type PluginStateCountParams = { pluginId: string; now: number };
const pluginStateCountQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>>
>();

export function countLivePluginStateEntries(
  db: DatabaseSync,
  params: PluginStateCountParams,
): number {
  let query = pluginStateCountQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>(db, (parameter) =>
      getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
        .where(
          "plugin_id",
          "=",
          parameter((value) => value.pluginId),
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
    pluginStateCountQueries.set(db, query);
  }
  const row = query(params).rows[0];
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
        eb.fn.countAll<number | bigint>().as("namespace_count"),
        eb.fn.min<number | bigint | null>("expires_at").as("next_expiry"),
      ])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)])),
  );
  return {
    namespaceCount: coerceRequiredSqliteNumber(row?.namespace_count ?? 0),
    nextExpiry: normalizeSqliteNumber(row?.next_expiry ?? null) ?? Infinity,
    now: params.now,
    sweepPending: true,
  };
}

export function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  protectedKey: string;
}): void {
  if (isRetainedPluginStateNamespace(params.namespace)) {
    return;
  }
  if (params.maxEntries === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Bounded plugin state requires maxEntries.",
    });
  }
  if (params.overflowPolicy === "reject-new") {
    return;
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: params.now,
    });
  if (namespaceCount <= params.maxEntries) {
    return;
  }
  const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    protectedKey: params.protectedKey,
    now: params.now,
    limit: namespaceCount - params.maxEntries,
  });
  if (params.retention) {
    params.retention.namespaceCount -= deleted;
  }
}

export function assertCanInsertPluginStateEntry(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
}): void {
  if (isRetainedPluginStateNamespace(params.namespace)) {
    return;
  }
  if (params.maxEntries === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Bounded plugin state requires maxEntries.",
    });
  }
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
}

export type PluginStateRegisterEntryParams = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number | undefined;
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
  retention?: PluginStateRetention,
): void {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    namespace: params.namespace,
    now,
    operation: "register",
    path: store.path,
  });
  // Counts belong to this transaction. Namespace expiry or a backward clock
  // invalidates them; ordinary writes update them incrementally.
  if (retention && (now < retention.now || now >= retention.nextExpiry)) {
    Object.assign(retention, readPluginStateRetention(store.db, { ...params, now }));
  }
  if (!retention || retention.sweepPending) {
    const deleted = deleteExpiredPluginStateEntries(store.db, now, params);
    if (retention) {
      retention.sweepPending = deleted === PLUGIN_STATE_EXPIRY_BATCH_ROWS;
    }
  }
  // Quotas and batch counts need existence, never the previous JSON payload.
  const existing =
    retention || params.overflowPolicy === "reject-new"
      ? hasPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now,
        })
      : false;
  if (!existing) {
    assertCanInsertPluginStateEntry({
      store,
      pluginId: params.pluginId,
      namespace: params.namespace,
      maxEntries: params.maxEntries,
      overflowPolicy: params.overflowPolicy,
      now,
      retention,
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
  });
}
