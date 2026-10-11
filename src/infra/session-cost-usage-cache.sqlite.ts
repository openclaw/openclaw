import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { isPidAlive } from "../shared/pid-alive.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseOperations } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import type { SessionCostUsageCacheRead } from "./session-cost-usage-cache-read.js";
import type { SessionCostUsageRollupSnapshot } from "./session-cost-usage-cache.kernel.js";
import { isSessionActorUsageRefreshRunning } from "./session-cost-usage-memory.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

// Per-agent SQLite storage for rebuildable per-session usage rollups.
type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

function captureCacheDatabaseOptions(inputOptions: OpenClawAgentDatabaseOptions) {
  const options = {
    ...inputOptions,
    env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
  };
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

type CacheWriteAuthority = () => void;
type CacheWriteKey = Extract<keyof AgentDatabaseOperations, `usageCache.${string}`>;

function createCacheWriter(options: ReturnType<typeof captureCacheDatabaseOptions>) {
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let prepared = false;
  let lockWriteStarted = false;
  return {
    get lockWriteStarted() {
      return lockWriteStarted;
    },
    async write<Key extends CacheWriteKey>(
      type: Key,
      input: AgentDatabaseOperations[Key]["input"],
      authority?: CacheWriteAuthority,
      signal?: AbortSignal,
    ): Promise<AgentDatabaseOperations[Key]["output"]> {
      const captured = structuredClone(input);
      const cleanup = type === "usageCache.releaseLock";
      const current = cleanup ? captureOpenClawAgentDatabaseExecution(options) : execution;
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent() {
          signal?.throwIfAborted();
          authority?.();
        },
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              if (!grant()) {
                throw new Error("Usage cache write authority expired");
              }
            }, binding.attachment),
          });
        },
      };
      try {
        return await runOpenClawAgentWorkerWrite(
          options,
          async () => {
            if (!prepared && !cleanup) {
              await current.prepare(source, signal);
              prepared = true;
            }
            source.assertCurrent();
            const result = await current.runExisting(source, async (worker) => {
              if (type === "usageCache.acquireLock") {
                lockWriteStarted = true;
              }
              return { value: await worker.execute({ type, input: captured }, { signal }) };
            });
            if (!result) {
              throw new Error("Usage cache database disappeared before write");
            }
            return result.value;
          },
          undefined,
          signal,
        );
      } finally {
        if (cleanup) {
          await current.release();
        }
      }
    },
    async close() {
      await execution.release();
    },
  };
}

async function readRefreshLock(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
): Promise<string | null> {
  const request: SessionCostUsageCacheRead = { kind: "usage-refresh-lock" };
  const result = await withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readUsageCache({
      request,
      env: { ...options.env, OPENCLAW_STATE_DIR: options.env.OPENCLAW_STATE_DIR },
    }),
  );
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
  const writer = createCacheWriter(
    captureCacheDatabaseOptions({
      agentId: normalizeAgentId(params.agentId),
      env: params.env,
      ...(params.databasePath ? { path: params.databasePath } : {}),
    }),
  );
  try {
    await writer.write("usageCache.prune", existing);
  } finally {
    await writer.close();
  }
}

function parseRefreshLock(raw: string | null): SessionCostUsageRefreshLock | null {
  const value = safeParseJsonRecord(raw ?? "");
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
}

export async function isSessionCostUsageRefreshRunning(
  agentId?: string,
  databasePath?: string,
): Promise<boolean> {
  const signal = getAsyncWorkSignal();
  const memory = captureSessionActorStorageOwner(
    { agentId, storePath: databasePath },
    { assertCurrent: () => signal?.throwIfAborted(), authorize() {} },
  );
  if (memory) {
    return isSessionActorUsageRefreshRunning(memory);
  }
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const raw = await readRefreshLock(options);
  const lock = parseRefreshLock(raw);
  // Status never waits for a writer; acquisition replaces stale locks with its existing CAS.
  return lock !== null && isPidAlive(lock.pid);
}

export function prepareSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
  owner?: {
    env?: NodeJS.ProcessEnv;
    assertCurrent?: CacheWriteAuthority;
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
  const writer = createCacheWriter(options);
  let acquiring: Promise<boolean> | undefined;
  let releasing: Promise<void> | undefined;
  let closed = false;
  let acquired = false;
  const assertCurrent = () => {
    if (closed || !acquired) {
      throw new Error("Usage cache refresh owner is closed");
    }
    owner?.assertCurrent?.();
  };
  const release = (): Promise<void> => {
    closed = true;
    releasing ??= (async () => {
      await acquiring?.catch(() => undefined);
      try {
        if (writer.lockWriteStarted) {
          await writer.write("usageCache.releaseLock", lockJson);
        }
      } finally {
        await writer.close();
      }
    })();
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
        const input = {
          previousRaw,
          previousOwnerIsRunning,
          lockJson,
          startedAt: lock.startedAt,
        };
        acquired = await writer.write("usageCache.acquireLock", input, owner?.assertCurrent);
        return acquired;
      })();
      return acquiring;
    },
    release,
    writeRollup(
      params: AgentDatabaseOperations["usageCache.writeRollup"]["input"],
      signal?: AbortSignal,
    ) {
      assertCurrent();
      return writer.write("usageCache.writeRollup", params, assertCurrent, signal);
    },
    pruneRows(rows: readonly SessionCostUsageRollupSnapshot[], signal?: AbortSignal) {
      assertCurrent();
      return writer.write("usageCache.prune", rows, assertCurrent, signal);
    },
  };
}
