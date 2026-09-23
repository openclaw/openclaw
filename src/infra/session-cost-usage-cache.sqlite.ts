import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import {
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  isIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { SessionCostUsageCacheRead } from "./session-cost-usage-cache-read.js";
import {
  acquireSessionCostUsageRefreshLockInDatabase,
  deleteSessionCostUsageRefreshLockInDatabase,
  pruneSessionCostUsageRollupsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageRollupSnapshot,
} from "./session-cost-usage-cache.kernel.js";

// Per-agent SQLite storage for rebuildable per-session usage rollups.
type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

function captureCacheDatabaseOptions(
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
) {
  const options = {
    ...inputOptions,
    env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
  };
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function runCacheWriteTransaction<T>(
  operation: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0],
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
  owner?: {
    database?: OpenClawAgentDatabase;
    assertCurrent?: (database: OpenClawAgentDatabase) => void;
    onAdmitted?: (database: OpenClawAgentDatabase) => void;
  },
): Promise<T> {
  const options = captureCacheDatabaseOptions(inputOptions);
  return withOpenClawAgentDatabaseWrite(
    options,
    (database) =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          if (current !== database || !isOpenClawAgentDatabasePathCurrent(current)) {
            throw new Error("Usage cache database changed before write admission");
          }
          owner?.assertCurrent?.(current);
          owner?.onAdmitted?.(current);
          return operation(current);
        },
        { ...options, path: database.path },
        transactionOptions,
      ),
    owner?.database?.db,
  );
}

async function readCacheDatabase(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
  request: SessionCostUsageCacheRead,
) {
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    const { readSessionCostUsageCache } = await import("./session-cost-usage-cache-read.js");
    return readSessionCostUsageCache(options, request);
  }
  return withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readUsageCache({
      request,
      env: { ...options.env, OPENCLAW_STATE_DIR: options.env.OPENCLAW_STATE_DIR },
    }),
  );
}

async function readRefreshLock(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
): Promise<string | null> {
  const result = await readCacheDatabase(options, { kind: "usage-refresh-lock" });
  if (result.kind !== "usage-refresh-lock") {
    throw new Error("Invalid usage refresh-lock worker result");
  }
  return result.value;
}

export async function deleteSessionCostUsageRollupsExcept(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  liveKeys: ReadonlySet<string>;
  rows: readonly SessionCostUsageRollupSnapshot[];
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
  const lock = parseRefreshLock(await readRefreshLock(options));
  // Status never waits for a writer; acquisition replaces stale locks with its existing CAS.
  return lock !== null && isPidAlive(lock.pid);
}

export function prepareSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
  owner?: {
    env?: NodeJS.ProcessEnv;
    assertCurrent?: (database?: OpenClawAgentDatabase) => void;
  },
) {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
    env: owner?.env,
  });
  const lock: SessionCostUsageRefreshLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerNonce: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  const lockJson = JSON.stringify(lock);
  let database: OpenClawAgentDatabase | undefined;
  let releaseBorrow: (() => void) | undefined;
  let acquiring: Promise<boolean> | undefined;
  let releasing: Promise<void> | undefined;
  let closed = false;
  let acquired = false;
  let mayOwnLock = false;
  const assertCurrent = (current?: OpenClawAgentDatabase) => {
    if (closed || !acquired) {
      throw new Error("Usage cache refresh owner is closed");
    }
    owner?.assertCurrent?.(current);
  };
  const release = (): Promise<void> => {
    closed = true;
    releasing ??= (async () => {
      await acquiring?.catch(() => undefined);
      if (mayOwnLock) {
        await runCacheWriteTransaction(
          (current) => deleteSessionCostUsageRefreshLockInDatabase(current.db, lockJson),
          options,
          { operationLabel: "session-cost-usage.refresh-lock.delete" },
          { database },
        );
        mayOwnLock = false;
      }
      releaseBorrow?.();
      releaseBorrow = undefined;
    })().catch((error: unknown) => {
      releasing = undefined;
      throw error;
    });
    return releasing;
  };
  return {
    acquire(): Promise<boolean> {
      if (closed) {
        return Promise.reject(new Error("Usage cache refresh owner is closed"));
      }
      acquiring ??= (async () => {
        owner?.assertCurrent?.();
        const previousRaw = await readRefreshLock(options);
        const previousLock = parseRefreshLock(previousRaw);
        const previousOwnerIsRunning = previousLock ? isPidAlive(previousLock.pid) : false;
        acquired = await runCacheWriteTransaction(
          (current) => {
            mayOwnLock = true;
            const granted = acquireSessionCostUsageRefreshLockInDatabase(current.db, {
              previousRaw,
              previousOwnerIsRunning,
              lockJson,
              startedAt: lock.startedAt,
            });
            if (!granted) {
              mayOwnLock = false;
            }
            return granted;
          },
          options,
          { operationLabel: "session-cost-usage.refresh-lock.acquire" },
          {
            assertCurrent: (current) => {
              if (closed) {
                throw new Error("Usage cache refresh owner is closed");
              }
              owner?.assertCurrent?.(current);
            },
            onAdmitted: (current) => {
              database = current;
              releaseBorrow = retainAgentDatabase(current.db);
            },
          },
        );
        if (!acquired) {
          releaseBorrow?.();
          releaseBorrow = undefined;
        }
        return acquired;
      })();
      return acquiring;
    },
    release,
    writeRollup(params: Parameters<typeof writeSessionCostUsageRollupInDatabase>[1]) {
      assertCurrent();
      return runCacheWriteTransaction(
        (current) => writeSessionCostUsageRollupInDatabase(current.db, params),
        options,
        { operationLabel: "session-cost-usage.rollup.write" },
        { database, assertCurrent },
      );
    },
    pruneRows(rows: readonly SessionCostUsageRollupSnapshot[]) {
      assertCurrent();
      return runCacheWriteTransaction(
        (current) => pruneSessionCostUsageRollupsInDatabase(current.db, rows),
        options,
        { operationLabel: "session-cost-usage.rollup.prune" },
        { database, assertCurrent },
      );
    },
  };
}
