import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import {
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseOperations } from "../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  pruneSessionCostUsageRollupsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageRollupSnapshot,
} from "./session-cost-usage-cache.kernel.js";
import {
  captureUsageCostIncognitoBinding,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
import { isSessionActorUsageRefreshRunning } from "./session-cost-usage-memory.js";
import { readDatabasePathIdentitySync, resolveDatabasePathKey } from "./sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

// Durable usage refreshes share one process-owned lease per resolved cache path.
const activeRefreshes = new Set<string>();

// Incognito refresh status remains with its actor-owned compute scope.
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

type CacheWriteAuthority = () => void;
type CacheWriteKey = Extract<keyof AgentDatabaseOperations, `usageCache.${string}`>;

function createCacheWriter(options: ReturnType<typeof captureCacheDatabaseOptions>) {
  // Incognito and maintenance scopes retain their process-held native owner.
  const observed = supportsOpenClawAgentDatabaseExecution(options)
    ? readDatabasePathIdentitySync(options.path)
    : undefined;
  // Retain the selected file before asynchronous refresh work starts.
  const execution = observed
    ? captureOpenClawAgentDatabaseExecution(
        options,
        observed.key.startsWith("path:") ? { expectedCreationIdentity: observed } : undefined,
      )
    : undefined;
  let database: OpenClawAgentDatabase | undefined;
  let releaseBorrow: (() => void) | undefined;
  let prepared = false;
  return {
    async write<Key extends CacheWriteKey>(
      type: Key,
      input: AgentDatabaseOperations[Key]["input"],
      native: (database: OpenClawAgentDatabase) => AgentDatabaseOperations[Key]["output"],
      operationLabel: string,
      authority?: CacheWriteAuthority,
      signal?: AbortSignal,
    ): Promise<AgentDatabaseOperations[Key]["output"]> {
      if (!execution) {
        return withOpenClawAgentDatabaseWrite(
          options,
          (opened) =>
            runOpenClawAgentWriteTransaction(
              (current) => {
                if (current !== opened || !isOpenClawAgentDatabasePathCurrent(current)) {
                  throw new Error("Usage cache database changed before write admission");
                }
                authority?.();
                signal?.throwIfAborted();
                database = current;
                releaseBorrow ??= retainAgentDatabase(current.db);
                return native(current);
              },
              options,
              { operationLabel },
            ),
          database?.db,
          signal,
        );
      }
      const captured = structuredClone(input);
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
      return runOpenClawAgentWorkerWrite(
        options,
        async () => {
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
      releaseBorrow?.();
      releaseBorrow = undefined;
    },
  };
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
    await writer.write(
      "usageCache.prune",
      existing,
      (database) => pruneSessionCostUsageRollupsInDatabase(database.db, existing),
      "session-cost-usage.rollup.prune",
    );
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
  suppliedIncognito?: UsageCostIncognitoBinding,
): Promise<boolean> {
  const memory = getSessionActorStorageBinding({ agentId, storePath: databasePath });
  if (memory) {
    return isSessionActorUsageRefreshRunning(memory);
  }
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const incognito =
    suppliedIncognito ??
    captureUsageCostIncognitoBinding({
      agentId: options.agentId,
      databasePath: options.path,
    });
  if (
    incognito &&
    (options.agentId !== incognito.actor.agentId || options.path !== incognito.actor.path)
  ) {
    throw new Error("Usage refresh status belongs to another actor");
  }
  if (!incognito) {
    return activeRefreshes.has(resolveDatabasePathKey(options.path));
  }
  const raw = await incognito.actor.sessions.withCompute(
    incognito.authority,
    incognito.target,
    (compute) =>
      compute.execute({
        type: incognito.target
          ? "session.compute.usage.refreshLock"
          : "session.compute.store.refreshLock",
        input: { ...incognito.target, request: {} },
      }),
    incognito.admissionSignal ?? getAsyncWorkSignal(),
  );
  incognito.actor.assertReadable();
  incognito.authority.assertCurrent();
  incognito.admissionSignal?.throwIfAborted();
  getAsyncWorkSignal()?.throwIfAborted();
  const lock = parseRefreshLock(raw);
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
  const writer = createCacheWriter(options);
  const refreshKey = resolveDatabasePathKey(options.path);
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
    releasing ??= writer
      .close()
      .then(() => {
        if (acquired) {
          activeRefreshes.delete(refreshKey);
          acquired = false;
        }
      })
      .catch((error: unknown) => {
        releasing = undefined;
        throw error;
      });
    return releasing;
  };
  return {
    async acquire(): Promise<boolean> {
      if (closed) {
        throw new Error("Usage cache refresh owner is closed");
      }
      owner?.assertCurrent?.();
      if (!acquired && activeRefreshes.has(refreshKey)) {
        return false;
      }
      activeRefreshes.add(refreshKey);
      acquired = true;
      return true;
    },
    release,
    writeRollup(
      params: Parameters<typeof writeSessionCostUsageRollupInDatabase>[1],
      signal?: AbortSignal,
    ) {
      assertCurrent();
      return writer.write(
        "usageCache.writeRollup",
        params,
        (current) => writeSessionCostUsageRollupInDatabase(current.db, params),
        "session-cost-usage.rollup.write",
        assertCurrent,
        signal,
      );
    },
    pruneRows(rows: readonly SessionCostUsageRollupSnapshot[], signal?: AbortSignal) {
      assertCurrent();
      return writer.write(
        "usageCache.prune",
        rows,
        (current) => pruneSessionCostUsageRollupsInDatabase(current.db, rows),
        "session-cost-usage.rollup.prune",
        assertCurrent,
        signal,
      );
    },
  };
}
