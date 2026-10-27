import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-admission-contract.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseOperations,
} from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabasePreparationExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  retireLegacySessionCostUsageCacheInDatabase,
  type SessionCostUsageRollupSnapshot,
} from "./session-cost-usage-cache.kernel.js";
import { isSessionActorUsageRefreshRunning } from "./session-cost-usage-memory.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readDatabasePathIdentitySync, resolveDatabasePathKey } from "./sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

// Durable usage refreshes share one process-owned lease per resolved cache path.
const activeRefreshes = new Map<string, Deferred>();

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

function createCacheWriteSource(
  authority?: CacheWriteAuthority,
  signal?: AbortSignal,
): AgentDatabaseRequestExecutionSource {
  return {
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
}

function createCacheWriter(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
  observed = readDatabasePathIdentitySync(options.path),
) {
  const expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined = observed.key.startsWith(
    "file:",
  )
    ? {
        kind: "file",
        physicalIdentity: observed.key.slice("file:".length),
        birthtime: observed.birthtime,
        nativeLocation: observed.canonicalPath,
      }
    : undefined;
  // Missing stores join their preparation owner; existing stores borrow at writer admission.
  let execution = observed.key.startsWith("path:")
    ? captureOpenClawAgentDatabasePreparationExecution(options)
    : undefined;
  let prepared = false;
  return {
    async prepareExisting(authority: CacheWriteAuthority, signal?: AbortSignal) {
      if (!observed.key.startsWith("file:")) {
        return;
      }
      const source = createCacheWriteSource(authority, signal);
      await runOpenClawAgentWorkerWrite(
        options,
        async () => {
          source.assertCurrent();
          execution ??= captureOpenClawAgentDatabasePreparationExecution(options, expectedIdentity);
          if (!prepared) {
            await execution.prepare(source, signal);
            prepared = true;
          }
        },
        undefined,
        signal,
        "background",
      );
    },
    async write<Key extends CacheWriteKey>(
      type: Key,
      input: AgentDatabaseOperations[Key]["input"],
      authority?: CacheWriteAuthority,
      signal?: AbortSignal,
    ): Promise<AgentDatabaseOperations[Key]["output"]> {
      const captured = structuredClone(input);
      const source = createCacheWriteSource(authority, signal);
      return runOpenClawAgentWorkerWrite(
        options,
        async () => {
          source.assertCurrent();
          execution ??= captureOpenClawAgentDatabasePreparationExecution(options, expectedIdentity);
          if (!prepared) {
            await execution.prepare(source, signal);
            prepared = true;
          }
          source.assertCurrent();
          const result = await execution.runExisting(source, async (worker) => {
            return { value: await worker.execute({ type, input: captured }, { signal }) };
          });
          if (!result) {
            throw new Error("Usage cache database disappeared before write");
          }
          return result.value;
        },
        undefined,
        signal,
        "background",
      );
    },
    async close() {
      await execution?.release();
    },
  };
}

export async function retireLegacySessionCostUsageCache(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): Promise<void> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(params.agentId),
    env: params.env,
    ...(params.databasePath ? { path: params.databasePath } : {}),
  });
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (maintenance?.ownsSchemaMaintenance) {
    // Doctor retains the native owner; ordinary worker admission cannot borrow it.
    await withOpenClawAgentDatabaseWrite(options, ({ db, path }) =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          maintenance.assertAdmission();
          retireLegacySessionCostUsageCacheInDatabase(db);
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: path,
          operationLabel: "session-cost-usage.legacy.retire",
          withCommit: (commit) => {
            maintenance.assertAdmission();
            commit();
          },
        },
      ),
    );
    return;
  }
  const writer = createCacheWriter(options);
  try {
    await writer.write("usageCache.retireLegacy", undefined);
  } finally {
    await writer.close();
  }
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
  return activeRefreshes.has(resolveDatabasePathKey(options.path));
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
  const observed = readDatabasePathIdentitySync(options.path);
  const refreshKey = observed.canonicalPath;
  let releasing: Promise<void> | undefined;
  let closed = false;
  let acquired: ReturnType<typeof createCacheWriter> | undefined;
  let completion: Deferred | undefined;
  const assertCurrent = () => {
    if (closed || !acquired) {
      throw new Error("Usage cache refresh owner is closed");
    }
    owner?.assertCurrent?.();
    return acquired;
  };
  const release = (): Promise<void> => {
    closed = true;
    releasing ??= (acquired?.close() ?? Promise.resolve())
      .then(() => {
        acquired = undefined;
      })
      .catch((error: unknown) => {
        releasing = undefined;
        throw error;
      })
      .finally(() => {
        // Failed cleanup stays retryable, but waiting scans can take their own writer.
        if (completion) {
          activeRefreshes.delete(refreshKey);
          completion.resolve();
          completion = undefined;
        }
      });
    return releasing;
  };
  return {
    async acquire(waitForRefresh = false): Promise<boolean> {
      const signal = getAsyncWorkSignal();
      while (!acquired) {
        if (closed) {
          throw new Error("Usage cache refresh owner is closed");
        }
        owner?.assertCurrent?.();
        const current = activeRefreshes.get(refreshKey);
        if (!current) {
          // Retain existing-file identity; only a missing store can join a preceding creator.
          const identity = observed.key.startsWith("file:")
            ? observed
            : readDatabasePathIdentitySync(options.path);
          if (identity.canonicalPath !== observed.canonicalPath) {
            throw new Error("Usage cache refresh changed its originally observed target");
          }
          acquired = createCacheWriter(options, identity);
          completion = createDeferredCore();
          activeRefreshes.set(refreshKey, completion);
          break;
        }
        if (!waitForRefresh) {
          return false;
        }
        await racePromiseWithAbortSignal(current.promise, signal, (aborted) => aborted.reason);
      }
      // Finish cold admission before a scan can hold its turn while requesting this writer.
      // Missing stores remain absent until an actual rollup needs to create them.
      await assertCurrent().prepareExisting(assertCurrent, signal);
      return true;
    },
    release,
    writeRollup(
      params: AgentDatabaseOperations["usageCache.writeRollup"]["input"],
      signal?: AbortSignal,
    ) {
      return assertCurrent().write("usageCache.writeRollup", params, assertCurrent, signal);
    },
    writeQuarters(
      rows: AgentDatabaseOperations["usageCache.writeQuarters"]["input"],
      signal?: AbortSignal,
    ) {
      return assertCurrent().write("usageCache.writeQuarters", rows, assertCurrent, signal);
    },
    pruneRows(rows: readonly SessionCostUsageRollupSnapshot[], signal?: AbortSignal) {
      return assertCurrent().write("usageCache.prune", rows, assertCurrent, signal);
    },
  };
}
