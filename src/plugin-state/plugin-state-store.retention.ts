import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
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
const pluginStateCountQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>(db, (parameter) =>
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
  ),
);

export function countLivePluginStateEntries(
  db: DatabaseSync,
  params: PluginStateCountParams,
): number {
  const row = pluginStateCountQuery(db)(params).rows[0];
  return coerceRequiredSqliteNumber(row?.count ?? 0);
}

type PluginStateRetention = {
  namespaceCount: number;
  nextExpiry: number;
  now: number;
  sweepPending: boolean;
};

type PluginStateRetentionParams = { pluginId: string; namespace: string; now: number };
type PluginStateRetentionRow = {
  namespace_count: number | bigint | null;
  next_expiry: number | bigint | null;
  first_expiry: number | bigint | null;
};

const pluginStateRetentionQuery = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<PluginStateRetentionParams, PluginStateRetentionRow>(db, (parameter) => {
    const now = parameter((value) => value.now);
    // Expired rows trigger cleanup; only a live deadline invalidates the retained count.
    return getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select((eb) => [
        eb.fn
          .sum<number | bigint | null>(
            eb
              .case()
              .when(eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
              .then(1)
              .else(0)
              .end(),
          )
          .as("namespace_count"),
        eb.fn
          .min<number | bigint | null>(
            eb.case().when("expires_at", ">", now).then(eb.ref("expires_at")).else(null).end(),
          )
          .as("next_expiry"),
        eb.fn.min<number | bigint | null>("expires_at").as("first_expiry"),
      ])
      .where(
        "plugin_id",
        "=",
        parameter((value) => value.pluginId),
      )
      .where(
        "namespace",
        "=",
        parameter((value) => value.namespace),
      );
  }),
);

export function readPluginStateRetention(
  db: DatabaseSync,
  params: PluginStateRetentionParams,
): PluginStateRetention {
  const row = pluginStateRetentionQuery(db)(params).rows[0];
  return {
    namespaceCount: coerceRequiredSqliteNumber(row?.namespace_count ?? 0),
    nextExpiry: normalizeSqliteNumber(row?.next_expiry ?? null) ?? Infinity,
    now: params.now,
    sweepPending: (normalizeSqliteNumber(row?.first_expiry ?? null) ?? Infinity) <= params.now,
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
}): string[] {
  if (isRetainedPluginStateNamespace(params.namespace)) {
    return [];
  }
  if (params.maxEntries === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Bounded plugin state requires maxEntries.",
    });
  }
  if (params.overflowPolicy === "reject-new") {
    return [];
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: params.now,
    });
  if (namespaceCount <= params.maxEntries) {
    return [];
  }
  const kysely = getPluginStateKysely(params.store.db);
  const keys = kysely
    .selectFrom("plugin_state_entries")
    .select("entry_key")
    .where("plugin_id", "=", params.pluginId)
    .where("namespace", "=", params.namespace)
    .where("entry_key", "!=", params.protectedKey)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
    .orderBy("created_at", "asc")
    .orderBy("entry_key", "asc")
    .limit(namespaceCount - params.maxEntries);
  const result = executeSqliteQuerySync(
    params.store.db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", keys)
      .returning(["plugin_id", "namespace", "entry_key"]),
  );
  pluginStatePublication.stageDeletions(params.store.db, result.rows);
  const deleted = result.rows.length;
  if (params.retention) {
    params.retention.namespaceCount -= deleted;
  }
  return result.rows.map((row) => row.entry_key);
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
  existingEntry?: boolean,
  onEviction?: (keys: readonly string[]) => void,
  now = Date.now(),
): void {
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
    existingEntry ??
    (retention || params.overflowPolicy === "reject-new"
      ? hasPluginStateEntry(store.db, { ...params, now })
      : false);
  if (!existing) {
    assertCanInsertPluginStateEntry({
      store,
      ...params,
      now,
      retention,
    });
  }
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      ...params,
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
  const evicted = enforcePostRegisterLimits({
    store,
    ...params,
    now,
    protectedKey: params.key,
    retention,
  });
  onEviction?.(evicted);
}
