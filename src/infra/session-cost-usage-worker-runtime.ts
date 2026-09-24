import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { Transferable } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptStatsBatchFromDatabase } from "../config/sessions/session-accessor.sqlite-transcript-stats.js";
import { restoreSessionColdTranscript } from "../config/sessions/session-cold-storage.js";
import { listDurableSqliteTargetPathsForSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { createMemoryTranscriptProjectionSource } from "../config/sessions/session-transcript-reconcile-memory.js";
import { withSessionCostUsageWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  readSessionCostUsageRollupByteRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupSnapshot,
} from "./session-cost-usage-cache.kernel.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
  createUsageCostResolver,
  resolveUsageCostPricingFingerprint,
} from "./session-cost-usage-pricing-context.js";
import { openUsageCostRefreshFailures } from "./session-cost-usage-refresh-health.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerHostEffects,
  type UsageCostWorkerHostReply,
  type UsageCostWorkerHostRequest,
  type UsageCostWorkerLocation,
  type UsageCostWorkerOperation,
  type UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type { UsageDailyBucket } from "./session-cost-usage.types.js";
import { withSqliteWorkerCleanupFailure } from "./sqlite-worker-broker-reply.js";

const USAGE_COST_WORKER_TIMEOUT_MS = 5 * 60_000;
const logger = createSubsystemLogger("usage-cost-cache");

export type PreparedUsageCostWorker = {
  location: UsageCostWorkerLocation;
  config?: OpenClawConfig;
  agentDir: string;
  databases: Array<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>;
};

export function prepareUsageCostWorker(params: {
  agentId: string;
  config?: OpenClawConfig;
  agentDir?: string;
  databasePath?: string;
  storePath?: string;
  sessionsDir?: string;
  sessionFiles?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): PreparedUsageCostWorker {
  const agentId = normalizeAgentId(params.agentId);
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope(
    {
      agentId,
      env,
      storePath:
        params.storePath ??
        (params.sessionsDir ? path.join(params.sessionsDir, "sessions.json") : undefined),
    },
    params.config,
  );
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env, path: params.databasePath });
  const databases = new Map<
    string,
    OpenClawAgentDatabaseOptions & { agentId: string; path: string }
  >();
  const add = (options: OpenClawAgentDatabaseOptions & { agentId: string }) => {
    const prepared = { ...options, env, path: resolveOpenClawAgentSqlitePath(options) };
    databases.set(JSON.stringify([prepared.agentId, prepared.path]), prepared);
  };
  add({ agentId, path: databasePath, env });
  const targets = [
    { agentId, storePath },
    ...listDurableSqliteTargetPathsForSessionStorePath(storePath).map((targetPath) => ({
      agentId,
      storePath: targetPath,
    })),
  ];
  for (const file of params.sessionFiles ?? []) {
    const marker = parseSqliteSessionFileMarker(file);
    if (marker) {
      targets.push(marker);
    }
  }
  const seen = new Set<string>();
  for (const target of targets) {
    const key = JSON.stringify([target.agentId, target.storePath]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    add(toDatabaseOptions(resolveSqliteReadScope({ ...target, env })));
  }
  return {
    location: {
      agentId,
      databasePath,
      storePath,
      // Windows preparation uses a Proxy; transfer data needs its resolved root in a plain snapshot.
      env: { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
    },
    config: params.config,
    agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, agentId),
    databases: [...databases.values()],
  };
}

export function resolveUsageCostWorkerDayBucket(dayBucket?: UsageDailyBucket): UsageDailyBucket {
  return dayBucket
    ? { ...dayBucket }
    : { mode: "time-zone", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function restoreWorkerFailure(error: unknown, hostErrors: Map<number, unknown>): unknown {
  const pending = [error];
  const seen = new Set<unknown>();
  const restoredOrigins = new Set<number>();
  let result = error;
  for (const current of pending) {
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof UsageCostWorkerReplyError) {
      const failure = current.failure;
      const remote = new Error(failure.message);
      if (failure.error) {
        retainOpenClawStateWorkerErrorPayload(remote, failure.error);
      }
      let restored: unknown = hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
      if (failure.hostOrigin !== undefined && hostErrors.has(failure.hostOrigin)) {
        restoredOrigins.add(failure.hostOrigin);
        const original = hostErrors.get(failure.hostOrigin);
        restored = failure.hostFailureOnly
          ? original
          : withSqliteWorkerCleanupFailure(
              toErrorObject(original, "Usage cache host effect failed"),
              restored,
            );
      }
      result =
        current === error
          ? restored
          : withSqliteWorkerCleanupFailure(
              toErrorObject(restored, "Usage cost worker failed"),
              result,
            );
    }
    if (current instanceof Error && current.cause) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  // Cancellation can retire the worker before an accepted write returns its failure.
  for (const [origin, failure] of hostErrors) {
    if (!restoredOrigins.has(origin)) {
      result = withSqliteWorkerCleanupFailure(
        toErrorObject(failure, "Usage cache host effect failed"),
        result,
      );
    }
  }
  return result;
}

type UsageCostWorkerRequest =
  | Exclude<UsageCostWorkerOperation, { kind: "refresh" }>
  | Omit<Extract<UsageCostWorkerOperation, { kind: "refresh" }>, "pricingFingerprint">;

export async function runUsageCostWorker(
  prepared: PreparedUsageCostWorker,
  operation: UsageCostWorkerRequest,
): Promise<UsageCostWorkerResult | { kind: "busy" }> {
  const location = structuredClone(prepared.location);
  const capturedOperation = structuredClone(operation);
  const signal = getAsyncWorkSignal();
  return withSessionCostUsageWorkerDatabases(prepared.databases, async (scope) => {
    const bindings = prepared.databases.map((options) => {
      const memory = isIncognitoOpenClawAgentSqlitePath(options.path, options);
      return {
        options,
        memory,
        database: memory ? getOpenClawAgentDatabaseIfOpen(options) : undefined,
        identity: memory
          ? undefined
          : fs.statSync(options.path, { bigint: true, throwIfNoEntry: false }),
      };
    });
    const cacheBinding = bindings.find(
      (binding) =>
        binding.options.agentId === location.agentId &&
        binding.options.path === location.databasePath,
    );
    if (!cacheBinding) {
      throw new Error("Usage cache database has no captured owner");
    }
    const assertBindingCurrent = (
      binding: (typeof bindings)[number],
      admittedDatabase?: OpenClawAgentDatabase,
    ) => {
      const admittedCache =
        admittedDatabase &&
        binding === cacheBinding &&
        admittedDatabase.agentId === binding.options.agentId &&
        admittedDatabase.path === binding.options.path &&
        getOpenClawAgentDatabaseIfOpen(binding.options) === admittedDatabase &&
        isOpenClawAgentDatabasePathCurrent(admittedDatabase);
      if (binding.memory) {
        const current = getOpenClawAgentDatabaseIfOpen(binding.options);
        if (!binding.database && current && admittedCache) {
          binding.database = current;
        }
        if (current !== binding.database || (binding.database && !binding.database.db.isOpen)) {
          throw new Error("Usage memory database changed during worker operation");
        }
        return;
      }
      const current = fs.statSync(binding.options.path, { bigint: true, throwIfNoEntry: false });
      if (!binding.identity && current && admittedCache) {
        binding.identity = current;
      }
      if (
        binding.identity
          ? !current || current.dev !== binding.identity.dev || current.ino !== binding.identity.ino
          : current !== undefined
      ) {
        throw new Error("Usage database changed during worker operation");
      }
    };
    const assertCurrent = (admittedDatabase?: OpenClawAgentDatabase) => {
      scope.assertCurrent();
      signal?.throwIfAborted();
      for (const binding of bindings) {
        if (binding !== cacheBinding) {
          assertBindingCurrent(binding);
        }
      }
      // Only the lock owner's admitted writer may create a previously absent cache.
      assertBindingCurrent(cacheBinding, admittedDatabase);
    };
    const resolveBinding = (target: Pick<SqliteSessionFileMarker, "agentId" | "storePath">) => {
      const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env: location.env }));
      const databasePath = resolveOpenClawAgentSqlitePath(options);
      const binding = bindings.find(
        (entry) => entry.options.agentId === options.agentId && entry.options.path === databasePath,
      );
      if (!binding) {
        throw new Error("Usage worker requested an unowned transcript database");
      }
      return binding;
    };
    const memoryBinding = (target: Pick<SqliteSessionFileMarker, "agentId" | "storePath">) => {
      const binding = resolveBinding(target);
      if (!binding.memory) {
        throw new Error("Usage worker requested an unowned memory database");
      }
      return binding;
    };
    const sources = new Map<string, ReturnType<typeof createMemoryTranscriptProjectionSource>>();
    const pruneRows: SessionCostUsageRollupSnapshot[] = [];
    scope.retainCleanup(async () => {
      for (const source of sources.values()) {
        source.clear();
      }
      sources.clear();
      pruneRows.length = 0;
    });
    const lock =
      capturedOperation.kind === "refresh"
        ? prepareSessionCostUsageRefreshLock(location.agentId, location.databasePath, {
            env: location.env,
            assertCurrent,
          })
        : undefined;
    if (lock) {
      // Cleanup custody exists before acquisition can wait or commit its token.
      scope.retainCleanup(lock.release);
      if (!(await lock.acquire())) {
        return { kind: "busy" };
      }
    }
    assertCurrent();
    const workerOperation: UsageCostWorkerOperation =
      capturedOperation.kind === "refresh"
        ? {
            ...capturedOperation,
            pricingFingerprint: await resolveUsageCostPricingFingerprint(
              prepared.config,
              prepared.agentDir,
            ),
          }
        : capturedOperation;
    const resolveCost = createUsageCostResolver({
      config: prepared.config,
      agentDir: prepared.agentDir,
    });
    const failures = openUsageCostRefreshFailures(location.env);
    const failureKey = (sessionFile: string) =>
      JSON.stringify([location.databasePath, sessionFile]);
    let activeSessionFile: string | undefined;
    const hostErrors = new Map<number, unknown>();
    let errorSequence = 0;
    try {
      const failureEntries = lock
        ? await failures.entries().catch((error: unknown) => {
            logger.warn("Could not read usage refresh failure history", { error });
            return [];
          })
        : [];
      const failedKeys = new Set(failureEntries.map((entry) => entry.key));
      const result = await scope.run(
        { kind: "usage-cost", location, operation: workerOperation, databases: [] },
        {
          signal,
          beforeDispatch: assertCurrent,
          inputBytes: 2 * JSON.stringify({ location, operation: workerOperation }).length,
          timeoutMs: USAGE_COST_WORKER_TIMEOUT_MS,
          onRequest: async (value, context) => {
            const transferList: Transferable[] = [];
            let reply: UsageCostWorkerHostReply;
            try {
              const assertRequestCurrent = () => {
                assertCurrent();
                context.signal.throwIfAborted();
              };
              assertRequestCurrent();
              if (!isRecord(value) || typeof value.kind !== "string") {
                throw new Error("Invalid usage worker host request");
              }
              // SAFETY: The paired worker constructs this union; host effects still check current authority.
              const request = value as UsageCostWorkerHostRequest;
              let output: UsageCostWorkerHostEffects[keyof UsageCostWorkerHostEffects]["output"];
              switch (request.kind) {
                case "refresh-session":
                  if (!lock) {
                    throw new Error("Usage report cannot refresh sessions");
                  }
                  activeSessionFile = request.input.sessionFile;
                  output = undefined;
                  break;
                case "pricing":
                  output = request.input.map(resolveCost);
                  break;
                case "restore": {
                  const binding = resolveBinding(request.input);
                  await restoreSessionColdTranscript(
                    { ...request.input, storePath: binding.options.path, env: location.env },
                    assertRequestCurrent,
                  );
                  output = undefined;
                  break;
                }
                case "memory-instances": {
                  const binding = memoryBinding(request.input);
                  output = binding.database
                    ? listSessionTranscriptInstances({
                        ...request.input,
                        storePath: binding.options.path,
                        env: location.env,
                        projection: "list",
                      }).map(({ agentId, sessionId, updatedAtMs }) => ({
                        agentId,
                        sessionId,
                        updatedAtMs,
                      }))
                    : [];
                  break;
                }
                case "memory-stats":
                  output = request.input.map((marker) => {
                    const binding = memoryBinding(marker);
                    return binding.database
                      ? readTranscriptStatsBatchFromDatabase(binding.database, [
                          marker.sessionId,
                        ])[0]
                      : undefined;
                  });
                  break;
                case "memory-cache": {
                  const binding = memoryBinding({
                    agentId: location.agentId,
                    storePath: location.databasePath,
                  });
                  output = binding.database
                    ? readSessionCostUsageRollupByteRowsInDatabase(
                        binding.database.db,
                        request.input.filePaths,
                      )
                    : [];
                  for (const row of output) {
                    if (!(row.valueJson.buffer instanceof ArrayBuffer)) {
                      throw new TypeError("Usage cache row bytes are not transferable");
                    }
                    transferList.push(row.valueJson.buffer);
                  }
                  break;
                }
                case "memory-transcript": {
                  await yieldImmediate(undefined, { signal: context.signal });
                  assertRequestCurrent();
                  const binding = memoryBinding(request.input.marker);
                  if (!binding.database) {
                    throw new Error("Usage memory transcript is no longer available");
                  }
                  const key = JSON.stringify(request.input);
                  let source = sources.get(key);
                  if (!source) {
                    source = createMemoryTranscriptProjectionSource(
                      binding.database,
                      binding.options,
                      request.input,
                    );
                    sources.set(key, source);
                  }
                  const frame = source.read(request.input.marker.sessionId);
                  output = frame;
                  if (frame.type === "source-frame") {
                    transferList.push(frame.bytes.buffer);
                  }
                  break;
                }
                case "memory-cache-body": {
                  const binding = memoryBinding({
                    agentId: location.agentId,
                    storePath: location.databasePath,
                  });
                  const row = binding.database
                    ? readSessionCostUsageRollupBodyInDatabase(binding.database.db, request.input)
                    : undefined;
                  // Copy native bytes into a standalone allocation before transferring custody.
                  const blob = row?.blob ? Uint8Array.from(row.blob) : null;
                  output = row ? { blob } : undefined;
                  if (blob) {
                    transferList.push(blob.buffer);
                  }
                  break;
                }
                case "prune-row":
                  if (!lock) {
                    throw new Error("Usage report cannot prune cache rows");
                  }
                  pruneRows.push({
                    key: request.input.key,
                    valueJson: request.input.value,
                    updatedAt: request.input.updatedAt,
                  });
                  output = undefined;
                  break;
                case "prune":
                  if (!lock) {
                    throw new Error("Usage report cannot prune cache rows");
                  }
                  await lock.pruneRows(pruneRows);
                  pruneRows.length = 0;
                  output = undefined;
                  break;
                case "write":
                  if (!lock) {
                    throw new Error("Usage report cannot write cache rows");
                  }
                  output = await lock.writeRollup({
                    rollupId: request.input.key,
                    previousValueJson: request.input.previousValue,
                    valueJson: request.input.value,
                    blob: request.input.blob,
                    updatedAt: request.input.updatedAt,
                  });
                  if (output && failedKeys.has(failureKey(request.input.key))) {
                    await failures
                      .delete(failureKey(request.input.key), {
                        assertCurrent: assertRequestCurrent,
                      })
                      .catch((error: unknown) => {
                        logger.warn("Could not clear usage refresh failure fact", { error });
                      });
                  }
                  activeSessionFile = undefined;
                  break;
                default:
                  throw new Error("Unknown usage worker host request");
              }
              assertRequestCurrent();
              reply = { ok: true, value: output };
            } catch (error) {
              const origin = ++errorSequence;
              hostErrors.set(origin, error);
              reply = {
                ok: false,
                origin,
                message: toErrorObject(error, "Usage host effect failed").message,
              };
            }
            return { input: reply, transferList, timeoutMs: USAGE_COST_WORKER_TIMEOUT_MS };
          },
        },
      );
      assertCurrent();
      return result;
    } catch (error) {
      let failure = restoreWorkerFailure(error, hostErrors);
      if (activeSessionFile && !signal?.aborted) {
        try {
          await failures.register(
            failureKey(activeSessionFile),
            {
              agentId: location.agentId,
              sessionFile: activeSessionFile,
              failedAt: Date.now(),
              reason: "Usage refresh failed; cached totals may be incomplete. Check Gateway logs.",
            },
            { assertCurrent },
          );
        } catch (healthError) {
          failure = withSqliteWorkerCleanupFailure(
            toErrorObject(failure, "Usage refresh failed"),
            healthError,
          );
        }
      }
      throw failure;
    }
  });
}
