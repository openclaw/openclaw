import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
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
  isIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type {
  AgentDatabaseOperations,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import type { SessionCostUsageCacheRead } from "./session-cost-usage-cache-read.js";
import {
  acquireSessionCostUsageRefreshLockInDatabase,
  deleteSessionCostUsageRefreshLockInDatabase,
  pruneSessionCostUsageRollupsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageRollupSnapshot,
} from "./session-cost-usage-cache.kernel.js";
import {
  captureUsageCostIncognitoBinding,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

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

type CacheWriteAuthority = (
  database?: OpenClawAgentDatabase,
  execution?: OpenClawAgentDatabaseExecution,
  opening?: boolean,
) => void;
type CacheWriteKey = Extract<keyof AgentDatabaseOperations, `usageCache.${string}`>;

function createCacheWriter(options: ReturnType<typeof captureCacheDatabaseOptions>) {
  // Incognito and maintenance scopes retain their process-held native owner.
  const execution = supportsOpenClawAgentDatabaseExecution(options)
    ? captureOpenClawAgentDatabaseExecution(options)
    : undefined;
  let identity: AgentDatabaseExecutionFileIdentity | undefined;
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
      onAdmitted?: () => void,
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
                authority?.(current);
                signal?.throwIfAborted();
                database = current;
                releaseBorrow ??= retainAgentDatabase(current.db);
                onAdmitted?.();
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
      // Exact-token cleanup can reopen the same file after a lost worker reply, never replay a write.
      const cleanup = type === "usageCache.releaseLock";
      const current = cleanup
        ? captureOpenClawAgentDatabaseExecution(options, { expectedIdentity: identity })
        : execution;
      let opening = false;
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent() {
          signal?.throwIfAborted();
          identity ??= current.fileIdentity;
          authority?.(undefined, current, opening);
        },
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              if (
                request.stage === "prepare" &&
                isRecord(request.facts) &&
                request.facts.kind === "shared-owner"
              ) {
                // The worker captured absence before this grant and checks it again before opening.
                opening = true;
              }
              if (request.stage === "transaction") {
                onAdmitted?.();
              }
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
              opening = false;
              prepared = true;
            }
            source.assertCurrent();
            const result = await current.runExisting(source, async (worker) => ({
              value: await worker.execute({ type, input: captured }, { signal }),
            }));
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
      await execution?.release();
      releaseBorrow?.();
      releaseBorrow = undefined;
    },
  };
}

async function readRefreshLock(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
): Promise<string | null> {
  const request: SessionCostUsageCacheRead = { kind: "usage-refresh-lock" };
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    const { readSessionCostUsageCache } = await import("./session-cost-usage-cache-read.js");
    return readSessionCostUsageCache(options, request).value;
  }
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
  const raw = incognito
    ? await incognito.actor.sessions.withCompute(
        incognito.authority,
        incognito.target,
        (compute) =>
          compute.execute(
            incognito.target
              ? {
                  type: "session.compute.usage.refreshLock",
                  input: { ...incognito.target, request: {} },
                }
              : { type: "session.compute.store.refreshLock", input: { request: {} } },
          ),
        incognito.admissionSignal ?? getAsyncWorkSignal(),
      )
    : await readRefreshLock(options);
  if (incognito) {
    incognito.actor.assertReadable();
    incognito.authority.assertCurrent();
    incognito.admissionSignal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
  }
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
  let mayOwnLock = false;
  const assertCurrent: CacheWriteAuthority = (current, execution, opening) => {
    if (closed || !acquired) {
      throw new Error("Usage cache refresh owner is closed");
    }
    owner?.assertCurrent?.(current, execution, opening);
  };
  const release = (): Promise<void> => {
    closed = true;
    releasing ??= (async () => {
      await acquiring?.catch(() => undefined);
      if (mayOwnLock) {
        await writer.write(
          "usageCache.releaseLock",
          lockJson,
          (current) => deleteSessionCostUsageRefreshLockInDatabase(current.db, lockJson),
          "session-cost-usage.refresh-lock.delete",
        );
        mayOwnLock = false;
      }
      await writer.close();
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
        const input = {
          previousRaw,
          previousOwnerIsRunning,
          lockJson,
          startedAt: lock.startedAt,
        };
        acquired = await writer.write(
          "usageCache.acquireLock",
          input,
          (current) => acquireSessionCostUsageRefreshLockInDatabase(current.db, input),
          "session-cost-usage.refresh-lock.acquire",
          (current, execution, opening) => {
            if (closed) {
              throw new Error("Usage cache refresh owner is closed");
            }
            owner?.assertCurrent?.(current, execution, opening);
          },
          () => {
            mayOwnLock = true;
          },
        );
        mayOwnLock = acquired;
        return acquired;
      })();
      return acquiring;
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
        undefined,
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
        undefined,
        signal,
      );
    },
  };
}
