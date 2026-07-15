import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
// Per-agent SQLite storage for the rebuildable session cost/usage cache.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const CACHE_SCOPE = "session-cost-usage";
const CACHE_KEY = "cache";
const REFRESH_LOCK_KEY = "refresh-lock";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

function readCacheValue(
  agentId: string | undefined,
  key: string,
  databasePath?: string,
): string | null {
  const database = openOpenClawAgentDatabase({
    agentId: normalizeAgentId(agentId),
    ...(databasePath ? { path: databasePath } : {}),
  });
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("cache_entries")
      .select("value_json")
      .where("scope", "=", CACHE_SCOPE)
      .where("key", "=", key)
      .limit(1),
  ).rows[0];
  return row?.value_json ?? null;
}

function upsertCacheValue(params: {
  agentId?: string;
  databasePath?: string;
  key: string;
  valueJson: string;
  updatedAt: number;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: CACHE_SCOPE,
            key: params.key,
            value_json: params.valueJson,
            blob: null,
            expires_at: null,
            updated_at: params.updatedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: params.valueJson,
              blob: null,
              expires_at: null,
              updated_at: params.updatedAt,
            }),
          ),
      );
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: `session-cost-usage.${params.key}.write` },
  );
}

function deleteCacheValueIfUnchanged(params: {
  agentId?: string;
  databasePath?: string;
  key: string;
  valueJson: string;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", CACHE_SCOPE)
          .where("key", "=", params.key)
          .where("value_json", "=", params.valueJson),
      );
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: `session-cost-usage.${params.key}.delete` },
  );
}

export function readSessionCostUsageCacheJson(
  agentId?: string,
  databasePath?: string,
): string | null {
  return readCacheValue(agentId, CACHE_KEY, databasePath);
}

export function writeSessionCostUsageCacheJson(params: {
  agentId?: string;
  databasePath?: string;
  valueJson: string;
  updatedAt: number;
}): void {
  upsertCacheValue({ ...params, key: CACHE_KEY });
}

function parseRefreshLock(raw: string | null): SessionCostUsageRefreshLock | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<SessionCostUsageRefreshLock> | null;
    if (
      !value ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      typeof value.ownerNonce !== "string" ||
      !value.ownerNonce
    ) {
      return null;
    }
    return { pid: value.pid, startedAt: value.startedAt, ownerNonce: value.ownerNonce };
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Owner nonces for refresh locks whose in-process holder is still live in THIS lifecycle.
// pid-liveness alone cannot reclaim a lock leaked by our own process: an in-process gateway
// restart (SIGUSR1 keeps the same pid for the process lifetime) can abandon a mid-refresh
// holder before its release runs, so pid-liveness reports "refreshing" forever (#103910).
const activeRefreshLockOwnerNonces = new Set<string>();

// A lock owned by another pid is live while that pid runs. A lock owned by our own pid is
// live only while its holder is still registered; an own-pid lock whose nonce is no longer
// registered is a self-lock leaked by a previous in-process lifecycle and is reclaimable.
function isRefreshLockHeldByLiveHolder(lock: SessionCostUsageRefreshLock): boolean {
  if (lock.pid === process.pid) {
    return activeRefreshLockOwnerNonces.has(lock.ownerNonce);
  }
  return isProcessRunning(lock.pid);
}

// Called at the in-process gateway restart boundary. Holders from the previous lifecycle
// never released, so drop their registrations; their own-pid locks then read as leaked
// self-locks and the next acquire/status check reclaims them instead of blocking (#103910).
export function clearSessionCostUsageRefreshHoldersForInProcessRestart(): void {
  activeRefreshLockOwnerNonces.clear();
}

export function isSessionCostUsageRefreshRunning(agentId?: string, databasePath?: string): boolean {
  const raw = readCacheValue(agentId, REFRESH_LOCK_KEY, databasePath);
  const lock = parseRefreshLock(raw);
  if (lock && isRefreshLockHeldByLiveHolder(lock)) {
    return true;
  }
  if (raw !== null) {
    deleteCacheValueIfUnchanged({
      agentId,
      databasePath,
      key: REFRESH_LOCK_KEY,
      valueJson: raw,
    });
  }
  return false;
}

export function acquireSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
): {
  acquired: boolean;
  release: () => void;
} {
  const previousRaw = readCacheValue(agentId, REFRESH_LOCK_KEY, databasePath);
  const previousLock = parseRefreshLock(previousRaw);
  // Holder liveness is resolved before BEGIN. The transaction only compares the
  // authoritative row and commits the prepared replacement synchronously.
  const previousOwnerIsRunning = previousLock ? isRefreshLockHeldByLiveHolder(previousLock) : false;
  const lock: SessionCostUsageRefreshLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerNonce: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  const lockJson = JSON.stringify(lock);
  const acquired = runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const currentRaw =
        executeSqliteQuerySync(
          database.db,
          kysely
            .selectFrom("cache_entries")
            .select("value_json")
            .where("scope", "=", CACHE_SCOPE)
            .where("key", "=", REFRESH_LOCK_KEY)
            .limit(1),
        ).rows[0]?.value_json ?? null;
      if (currentRaw !== previousRaw || previousOwnerIsRunning) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: CACHE_SCOPE,
            key: REFRESH_LOCK_KEY,
            value_json: lockJson,
            blob: null,
            expires_at: null,
            updated_at: lock.startedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: lockJson,
              blob: null,
              expires_at: null,
              updated_at: lock.startedAt,
            }),
          ),
      );
      return true;
    },
    {
      agentId: normalizeAgentId(agentId),
      ...(databasePath ? { path: databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.refresh-lock.acquire" },
  );
  if (acquired) {
    // Register the live holder so a subsequent status/acquire on this pid treats the row
    // as live until release; the restart boundary clears this to reclaim leaked self-locks.
    activeRefreshLockOwnerNonces.add(lock.ownerNonce);
  }
  return {
    acquired,
    release: () => {
      if (acquired) {
        activeRefreshLockOwnerNonces.delete(lock.ownerNonce);
        deleteCacheValueIfUnchanged({
          agentId,
          databasePath,
          key: REFRESH_LOCK_KEY,
          valueJson: lockJson,
        });
      }
    },
  };
}
