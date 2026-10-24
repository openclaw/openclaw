import path from "node:path";
import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { restoreSessionColdTranscript } from "../config/sessions/session-cold-storage.js";
import { listDurableSqliteTargetPathsForSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import type { SessionCostUsageRollupSnapshot } from "./session-cost-usage-cache.kernel.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import { runSessionActorUsage } from "./session-cost-usage-memory.js";
import {
  createUsageCostResolver,
  prepareUsageCostPricing,
} from "./session-cost-usage-pricing-context.js";
import type { UsageCostResolver } from "./session-cost-usage-pricing.js";
import { openUsageCostRefreshFailures } from "./session-cost-usage-refresh-health.js";
import { withSessionCostUsageWorkerDatabases } from "./session-cost-usage-worker-scope.js";
import {
  UsageCostWorkerReplyError,
  type UsageCostWorkerHostEffects,
  type UsageCostWorkerHostRequest,
  type UsageCostWorkerInput,
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
  stores: UsageCostWorkerInput["stores"];
  archiveStorePaths: string[];
  sessionActor?: SessionActorStorageBinding;
  memory?: NonNullable<ReturnType<typeof captureSessionActorStorageOwner>>;
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
  sessionActor?: SessionActorStorageBinding;
}): PreparedUsageCostWorker {
  const signal = getAsyncWorkSignal();
  const authority = { assertCurrent: () => signal?.throwIfAborted(), authorize() {} };
  let memory: ReturnType<typeof captureSessionActorStorageOwner>;
  for (const scope of [
    { ...params, storePath: params.storePath ?? params.databasePath },
    ...(params.sessionFiles ?? []).flatMap((file) => {
      const marker = parseSqliteSessionFileMarker(file);
      return marker ? [{ ...marker, env: params.env }] : [];
    }),
  ]) {
    memory = captureSessionActorStorageOwner(scope, authority);
    if (memory) {
      break;
    }
  }
  if (memory) {
    const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    return {
      location: {
        agentId: memory.agentId,
        databasePath: memory.path,
        storePath: memory.path,
        env: { ...env },
      },
      config: params.config,
      agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, memory.agentId),
      databases: [],
      stores: [],
      archiveStorePaths: [],
      sessionActor: memory.binding,
      memory,
    };
  }
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
  const archiveStorePaths = listDurableSqliteTargetPathsForSessionStorePath(storePath);
  const targets = [
    { agentId, storePath },
    ...archiveStorePaths.map((targetPath) => ({
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
  const stores = new Map<string, UsageCostWorkerInput["stores"][number]>();
  for (const target of targets) {
    const key = JSON.stringify([target.agentId, target.storePath]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const database = { agentId: options.agentId, path: resolveOpenClawAgentSqlitePath(options) };
    add(options);
    stores.set(key, { agentId: target.agentId, storePath: target.storePath, database });
    // Scanners use physical markers; preserve the logical agent when the store is shared.
    stores.set(JSON.stringify([target.agentId, database.path]), {
      agentId: target.agentId,
      storePath: database.path,
      database,
    });
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
    stores: [...stores.values()],
    archiveStorePaths,
  };
}

export function resolveUsageCostWorkerDayBucket(dayBucket?: UsageDailyBucket): UsageDailyBucket {
  return dayBucket
    ? { ...dayBucket }
    : { mode: "time-zone", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function restoreWorkerFailure(error: unknown, hostErrors: Set<Error>): unknown {
  let result = error;
  for (const current of collectErrorGraphCandidates(error, (entry) =>
    entry instanceof Error
      ? [entry.cause, ...(entry instanceof AggregateError ? entry.errors : [])]
      : [],
  )) {
    if (current instanceof UsageCostWorkerReplyError) {
      const failure = current.failure;
      const remote = new Error(failure.message);
      if (failure.error) {
        retainOpenClawStateWorkerErrorPayload(remote, failure.error);
      }
      const restored = hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
      result =
        current === error
          ? restored
          : withSqliteWorkerCleanupFailure(
              toErrorObject(restored, "Usage cost worker failed"),
              result,
            );
    }
  }
  const restoredErrors = new Set(
    collectErrorGraphCandidates(result, (entry) =>
      entry instanceof Error
        ? [entry.cause, ...(entry instanceof AggregateError ? entry.errors : [])]
        : [],
    ),
  );
  // Cancellation can retire the worker before an accepted write returns its failure.
  for (const failure of hostErrors) {
    if (!restoredErrors.has(failure)) {
      result = withSqliteWorkerCleanupFailure(failure, result);
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
  if (prepared.memory) {
    const pricing =
      operation.kind === "refresh"
        ? await prepareUsageCostPricing(prepared.config, prepared.agentDir)
        : undefined;
    const request: UsageCostWorkerOperation =
      operation.kind === "refresh"
        ? { ...operation, pricingFingerprint: pricing!.fingerprint() }
        : operation;
    return runSessionActorUsage(
      prepared.memory,
      request,
      createUsageCostResolver(prepared, pricing),
    );
  }
  return runPreparedUsageCostWorker(prepared, operation);
}

async function runPreparedUsageCostWorker(
  prepared: PreparedUsageCostWorker,
  operation: UsageCostWorkerRequest,
): Promise<UsageCostWorkerResult | { kind: "busy" }> {
  const { location, archiveStorePaths, stores } = prepared;
  const capturedOperation = structuredClone(operation);
  const signal = getAsyncWorkSignal();
  return withSessionCostUsageWorkerDatabases(prepared.databases, async (scope) => {
    const assertCurrent = () => {
      scope.assertCurrent();
      signal?.throwIfAborted();
    };
    const resolveBinding = (target: Pick<SqliteSessionFileMarker, "agentId" | "storePath">) => {
      const binding = stores.find(
        (entry) => entry.agentId === target.agentId && entry.storePath === target.storePath,
      )?.database;
      if (!binding) {
        throw new Error("Usage worker requested an unowned transcript database");
      }
      return binding;
    };
    const pruneRows: SessionCostUsageRollupSnapshot[] = [];
    const lock =
      capturedOperation.kind === "refresh"
        ? prepareSessionCostUsageRefreshLock(location.agentId, location.databasePath, {
            env: location.env,
            assertCurrent,
          })
        : undefined;
    if (lock) {
      scope.retainCleanup(lock.release);
    }
    const requireLock = (action: string) => {
      if (!lock) {
        throw new Error(`Usage report cannot ${action}`);
      }
      return lock;
    };
    if (lock) {
      if (!(await lock.acquire())) {
        return { kind: "busy" };
      }
    }
    assertCurrent();
    let workerOperation: UsageCostWorkerOperation;
    let resolveCost: UsageCostResolver;
    if (capturedOperation.kind === "refresh") {
      const pricing = await prepareUsageCostPricing(prepared.config, prepared.agentDir);
      workerOperation = { ...capturedOperation, pricingFingerprint: pricing.fingerprint() };
      resolveCost = createUsageCostResolver(prepared, pricing);
    } else {
      workerOperation = capturedOperation;
      resolveCost = createUsageCostResolver(prepared);
    }
    const failures = openUsageCostRefreshFailures(location.env);
    const failureKey = (sessionFile: string) =>
      JSON.stringify([location.databasePath, sessionFile]);
    const uncommittedSessionFiles = new Set<string>();
    const hostErrors = new Set<Error>();
    try {
      const failureEntries = lock
        ? await failures.entries().catch((error: unknown) => {
            logger.warn("Could not read usage refresh failure history", { error });
            return [];
          })
        : [];
      const failedKeys = new Set(failureEntries.map((entry) => entry.key));
      const result = await scope.run(
        {
          kind: "usage-cost",
          location,
          operation: workerOperation,
          databases: [],
          stores,
          archiveStorePaths,
        },
        {
          signal,
          beforeDispatch: assertCurrent,
          inputBytes:
            2 *
            JSON.stringify({ location, operation: workerOperation, archiveStorePaths, stores })
              .length,
          timeoutMs: USAGE_COST_WORKER_TIMEOUT_MS,
          onRequest: async (value, context) => {
            try {
              const assertRequestCurrent = () => {
                assertCurrent();
                context.signal.throwIfAborted();
              };
              assertRequestCurrent();
              // SAFETY: The paired worker constructs this union; host effects still check current authority.
              const request = value as UsageCostWorkerHostRequest;
              let output: UsageCostWorkerHostEffects[keyof UsageCostWorkerHostEffects]["output"] =
                undefined;
              switch (request.kind) {
                case "refresh-session":
                  requireLock("refresh sessions");
                  uncommittedSessionFiles.add(request.input.sessionFile);
                  break;
                case "pricing":
                  output = request.input.map(resolveCost);
                  break;
                case "restore": {
                  const binding = resolveBinding(request.input);
                  await restoreSessionColdTranscript(
                    { ...request.input, storePath: binding.path, env: location.env },
                    assertRequestCurrent,
                    undefined,
                    undefined,
                    context.signal,
                  );
                  break;
                }
                case "prune-rows":
                  for (const row of request.input) {
                    pruneRows.push({
                      key: row.key,
                      valueJson: row.value,
                      updatedAt: row.updatedAt,
                    });
                  }
                  break;
                case "prune":
                  await requireLock("prune cache rows").pruneRows(pruneRows, context.signal);
                  pruneRows.length = 0;
                  break;
                case "write":
                  output = await requireLock("write cache rows").writeRollup(
                    request.input.map((row) => ({
                      rollupId: row.key,
                      valueJson: row.value,
                      blob: row.blob,
                      updatedAt: row.updatedAt,
                      partitions: row.partitions,
                      removedDates: row.removedDates,
                      replacePartitions: row.replacePartitions,
                    })),
                    context.signal,
                  );
                  for (const row of request.input) {
                    if (!output) {
                      continue;
                    }
                    uncommittedSessionFiles.delete(row.key);
                    if (!failedKeys.has(failureKey(row.key))) {
                      continue;
                    }
                    await failures
                      .delete(failureKey(row.key), {
                        assertCurrent: assertRequestCurrent,
                        signal: context.signal,
                      })
                      .catch((error: unknown) => {
                        logger.warn("Could not clear usage refresh failure fact", { error });
                      });
                  }
                  break;
                default:
                  throw new Error("Unknown usage worker host request");
              }
              assertRequestCurrent();
              return { input: output, timeoutMs: USAGE_COST_WORKER_TIMEOUT_MS };
            } catch (error) {
              const failure = toErrorObject(error, "Usage host effect failed");
              hostErrors.add(failure);
              throw failure;
            }
          },
        },
      );
      assertCurrent();
      return result;
    } catch (error) {
      let failure = restoreWorkerFailure(error, hostErrors);
      for (const sessionFile of signal?.aborted ? [] : uncommittedSessionFiles) {
        try {
          await failures.register(
            failureKey(sessionFile),
            {
              agentId: location.agentId,
              sessionFile,
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
