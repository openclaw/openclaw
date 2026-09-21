import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder, type AliasableExpression } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const LEGACY_CACHE_SCOPE = "session-cost-usage";
const LEGACY_CACHE_KEY = "cache";
const REFRESH_LOCK_KEY = "refresh-lock";
const RETIRED_ROLLUP_SCOPE = "session-cost-usage-rollup-v1";
const ROLLUP_SCOPE = "session-cost-usage-rollup-v2";
const ROLLUP_PRUNE_BATCH_SIZE = 32;

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;
const cacheExpressions = expressionBuilder<AgentCacheDatabase, "cache_entries">();

export type SessionCostUsageRollupRow = {
  key: string;
  updatedAt: number;
  valueJson: string;
};

export type SessionCostUsageRollupByteRow = Omit<SessionCostUsageRollupRow, "valueJson"> & {
  valueJson: Uint8Array;
};

type SessionCostUsageJson = string | Uint8Array;

export type SessionCostUsageRollupSnapshot = Omit<SessionCostUsageRollupRow, "valueJson"> & {
  valueJson: SessionCostUsageJson;
};

function cacheJsonText(value: SessionCostUsageJson) {
  return typeof value === "string"
    ? value
    : cacheExpressions.cast<string>(cacheExpressions.val(value), "text");
}

export function readSessionCostUsageRefreshLockInDatabase(db: DatabaseSync): string | null {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("cache_entries")
      .select("value_json")
      .where("scope", "=", LEGACY_CACHE_SCOPE)
      .where("key", "=", REFRESH_LOCK_KEY)
      .limit(1),
  ).rows[0];
  return row?.value_json ?? null;
}

export function readSessionCostUsageRollupRowsInDatabase(
  db: DatabaseSync,
  filePaths?: readonly string[],
): SessionCostUsageRollupRow[] {
  return readSessionCostUsageRollupValuesInDatabase(
    db,
    filePaths,
    cacheExpressions.ref("value_json"),
  );
}

export function readSessionCostUsageRollupByteRowsInDatabase(
  db: DatabaseSync,
  filePaths?: readonly string[],
): SessionCostUsageRollupByteRow[] {
  return readSessionCostUsageRollupValuesInDatabase(
    db,
    filePaths,
    cacheExpressions.cast<Uint8Array | null>("value_json", "blob"),
  );
}

function readSessionCostUsageRollupValuesInDatabase<Value extends string | Uint8Array>(
  db: DatabaseSync,
  filePaths: readonly string[] | undefined,
  valueJson: AliasableExpression<Value | null>,
) {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  // Bound SQL parameters even when a historical family contains many instances.
  const batches = filePaths ? chunkItems([...new Set(filePaths)], 500) : [undefined];
  return batches
    .flatMap((keys) => {
      const query = kysely
        .selectFrom("cache_entries")
        .select(["key", valueJson.as("value_json"), "updated_at"])
        .where("scope", "=", ROLLUP_SCOPE);
      return executeSqliteQuerySync(db, keys ? query.where("key", "in", keys) : query).rows;
    })
    .flatMap((row) =>
      row.value_json === null
        ? []
        : [{ key: row.key, valueJson: row.value_json, updatedAt: row.updated_at }],
    );
}

export function writeSessionCostUsageRollupInDatabase(
  db: DatabaseSync,
  params: {
    rollupId: string;
    previousValueJson: Uint8Array | null;
    valueJson: Uint8Array;
    updatedAt: number;
  },
): boolean {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  const values = {
    value_json: cacheJsonText(params.valueJson),
    blob: null,
    expires_at: null,
    updated_at: params.updatedAt,
  };
  if (params.previousValueJson === null) {
    return (
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("cache_entries")
          .values({ scope: ROLLUP_SCOPE, key: params.rollupId, ...values })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet(values).where("value_json", "is", null),
          ),
      ).numAffectedRows === 1n
    );
  }
  return (
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("cache_entries")
        .set(values)
        .where("scope", "=", ROLLUP_SCOPE)
        .where("key", "=", params.rollupId)
        .where("value_json", "=", cacheJsonText(params.previousValueJson)),
    ).numAffectedRows === 1n
  );
}

export function pruneSessionCostUsageRollupsInDatabase(
  db: DatabaseSync,
  existing: readonly SessionCostUsageRollupSnapshot[],
): void {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  for (const batch of chunkItems(existing, ROLLUP_PRUNE_BATCH_SIZE)) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("cache_entries")
        .where("scope", "=", ROLLUP_SCOPE)
        // Keep indexed key probes and each snapshot's exact comparison together.
        .where(
          "key",
          "in",
          batch.map((row) => row.key),
        )
        .where((eb) =>
          eb.or(
            batch.map((row) =>
              eb.and([
                eb("key", "=", row.key),
                eb("value_json", "=", cacheJsonText(row.valueJson)),
                eb("updated_at", "=", row.updatedAt),
              ]),
            ),
          ),
        ),
    );
  }
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("cache_entries")
      .where("scope", "=", LEGACY_CACHE_SCOPE)
      .where("key", "=", LEGACY_CACHE_KEY),
  );
  // v1 duplicated a multi-megabyte pricing catalog per row (#115282).
  // Delete by scope so those values are never materialized during cleanup.
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("cache_entries").where("scope", "=", RETIRED_ROLLUP_SCOPE),
  );
}

export function deleteSessionCostUsageRefreshLockInDatabase(
  db: DatabaseSync,
  valueJson: string,
): void {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("cache_entries")
      .where("scope", "=", LEGACY_CACHE_SCOPE)
      .where("key", "=", REFRESH_LOCK_KEY)
      .where("value_json", "=", valueJson),
  );
}

export function acquireSessionCostUsageRefreshLockInDatabase(
  db: DatabaseSync,
  params: {
    previousRaw: string | null;
    previousOwnerIsRunning: boolean;
    lockJson: string;
    startedAt: number;
  },
): boolean {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(db);
  const currentRaw =
    executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("cache_entries")
        .select("value_json")
        .where("scope", "=", LEGACY_CACHE_SCOPE)
        .where("key", "=", REFRESH_LOCK_KEY)
        .limit(1),
    ).rows[0]?.value_json ?? null;
  if (currentRaw !== params.previousRaw || params.previousOwnerIsRunning) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("cache_entries")
      .values({
        scope: LEGACY_CACHE_SCOPE,
        key: REFRESH_LOCK_KEY,
        value_json: params.lockJson,
        blob: null,
        expires_at: null,
        updated_at: params.startedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope", "key"]).doUpdateSet({
          value_json: params.lockJson,
          blob: null,
          expires_at: null,
          updated_at: params.startedAt,
        }),
      ),
  );
  return true;
}
