import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "../routing/session-key.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import {
  acquireSessionCostUsageRefreshLockInDatabase,
  deleteSessionCostUsageRefreshLockInDatabase,
  pruneSessionCostUsageRollupsInDatabase,
  readSessionCostUsageRefreshLockInDatabase,
  readSessionCostUsageRollupRowsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";

// Per-agent SQLite storage for rebuildable per-session usage rollups.
type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

function captureCacheDatabaseOptions(
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
) {
  const options = { ...inputOptions, env: { ...(inputOptions.env ?? process.env) } };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function runCacheWriteTransaction<T>(
  operation: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0],
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
): Promise<T> {
  const options = captureCacheDatabaseOptions(inputOptions);
  return withOpenClawAgentDatabaseAsync(options, (database) =>
    runOpenClawAgentWriteTransaction(
      operation,
      { ...options, path: database.path },
      transactionOptions,
    ),
  );
}

function readCacheDatabase<T>(
  agentId: string | undefined,
  databasePath: string | undefined,
  operation: (database: { db: DatabaseSync }) => T,
): T | undefined {
  try {
    const result = withOpenClawAgentDatabaseReadOnly(operation, {
      agentId: normalizeAgentId(agentId),
      ...(databasePath ? { path: databasePath } : {}),
    });
    return result.found ? result.value : undefined;
  } catch (error) {
    if (!isTransientSqliteError(error)) {
      throw error;
    }
    // Usage rollups are rebuildable cache; stale or empty data beats failing the dashboard.
    return undefined;
  }
}

function readRefreshLock(agentId: string | undefined, databasePath?: string): string | null {
  return (
    readCacheDatabase(agentId, databasePath, (database) =>
      readSessionCostUsageRefreshLockInDatabase(database.db),
    ) ?? null
  );
}

async function deleteRefreshLockIfUnchanged(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  valueJson: string;
}): Promise<void> {
  await runCacheWriteTransaction(
    (database) => deleteSessionCostUsageRefreshLockInDatabase(database.db, params.valueJson),
    {
      agentId: normalizeAgentId(params.agentId),
      env: params.env,
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.refresh-lock.delete" },
  );
}

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
  filePaths?: readonly string[],
): SessionCostUsageRollupRow[] {
  return (
    readCacheDatabase(agentId, databasePath, (database) =>
      readSessionCostUsageRollupRowsInDatabase(database.db, filePaths),
    ) ?? []
  );
}

export async function writeSessionCostUsageRollup(params: {
  agentId?: string;
  databasePath?: string;
  rollupId: string;
  previousValueJson: string | null;
  valueJson: string;
  updatedAt: number;
}): Promise<boolean> {
  return runCacheWriteTransaction(
    (database) => writeSessionCostUsageRollupInDatabase(database.db, params),
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.write" },
  );
}

export async function deleteSessionCostUsageRollupsExcept(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  liveKeys: ReadonlySet<string>;
  rows: readonly SessionCostUsageRollupRow[];
}): Promise<void> {
  const existing = params.rows.filter((row) => !params.liveKeys.has(row.key));
  await runCacheWriteTransaction(
    (database) => pruneSessionCostUsageRollupsInDatabase(database.db, existing),
    {
      agentId: normalizeAgentId(params.agentId),
      env: params.env,
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.prune" },
  );
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

export async function isSessionCostUsageRefreshRunning(
  agentId?: string,
  databasePath?: string,
): Promise<boolean> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const raw = readRefreshLock(options.agentId, options.path);
  const lock = parseRefreshLock(raw);
  if (lock && isPidAlive(lock.pid)) {
    return true;
  }
  if (raw !== null) {
    await deleteRefreshLockIfUnchanged({
      agentId: options.agentId,
      databasePath: options.path,
      env: options.env,
      valueJson: raw,
    });
    const currentLock = parseRefreshLock(readRefreshLock(options.agentId, options.path));
    return currentLock !== null && isPidAlive(currentLock.pid);
  }
  return false;
}

export async function acquireSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const previousRaw = readRefreshLock(options.agentId, options.path);
  const previousLock = parseRefreshLock(previousRaw);
  // Process liveness is resolved before BEGIN. The transaction only compares
  // the authoritative row and commits the prepared replacement synchronously.
  const previousOwnerIsRunning = previousLock ? isPidAlive(previousLock.pid) : false;
  const lock: SessionCostUsageRefreshLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerNonce: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  const lockJson = JSON.stringify(lock);
  const acquired = await runCacheWriteTransaction(
    (database) =>
      acquireSessionCostUsageRefreshLockInDatabase(database.db, {
        previousRaw,
        previousOwnerIsRunning,
        lockJson,
        startedAt: lock.startedAt,
      }),
    options,
    { operationLabel: "session-cost-usage.refresh-lock.acquire" },
  );
  return {
    acquired,
    release: async () => {
      if (acquired) {
        await deleteRefreshLockIfUnchanged({
          agentId: options.agentId,
          databasePath: options.path,
          env: options.env,
          valueJson: lockJson,
        });
      }
    },
  };
}
