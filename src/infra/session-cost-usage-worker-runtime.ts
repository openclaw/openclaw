import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { Transferable } from "node:worker_threads";
import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
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
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
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
  createIncognitoUsageCostAdapter,
  createUsageCostIncognitoReadObservation,
  captureUsageCostIncognitoBinding,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
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
  incognito?: UsageCostIncognitoBinding;
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
  incognito?: UsageCostIncognitoBinding;
}): PreparedUsageCostWorker {
  const incognito = captureUsageCostIncognitoBinding(params);
  const agentId = normalizeAgentId(params.agentId);
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope(
    {
      agentId,
      env,
      storePath:
        params.storePath ??
        incognito?.actor.path ??
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
    incognito,
  };
}

export function resolveUsageCostWorkerDayBucket(dayBucket?: UsageDailyBucket): UsageDailyBucket {
  return dayBucket
    ? { ...dayBucket }
    : { mode: "time-zone", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function restoreWorkerFailure(error: unknown, hostErrors: Map<number, unknown>): unknown {
  const restoredOrigins = new Set<number>();
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
  suppliedIncognito?: UsageCostIncognitoBinding,
): Promise<UsageCostWorkerResult | { kind: "busy" }> {
  const incognito = suppliedIncognito ?? prepared.incognito;
  if (!incognito) {
    return runPreparedUsageCostWorker(prepared, operation);
  }
  incognito.admissionSignal?.throwIfAborted();
  const captured = {
    ...prepared,
    location: structuredClone(prepared.location),
    databases: structuredClone(prepared.databases),
  };
  const capturedOperation = structuredClone(operation);
  const target = structuredClone(incognito.target);
  const { agentId, path: databasePath } = incognito.actor;
  if (
    captured.location.agentId !== agentId ||
    !captured.databases.some((entry) => entry.agentId === agentId && entry.path === databasePath) ||
    captured.databases.some(
      (entry) =>
        isIncognitoOpenClawAgentSqlitePath(entry.path, entry) &&
        (entry.agentId !== agentId || entry.path !== databasePath),
    )
  ) {
    throw new Error("Usage actor does not own the prepared database");
  }
  const marker = { agentId, storePath: databasePath };
  const selectedFiles =
    capturedOperation.kind === "sessions"
      ? capturedOperation.sessions.map((entry) => entry.sessionFile)
      : "sessionFiles" in capturedOperation
        ? (capturedOperation.sessionFiles ?? [])
        : [];
  if (
    [
      ...selectedFiles,
      ...(capturedOperation.kind === "refresh"
        ? (capturedOperation.rebuildRows?.map((row) => row.key) ?? [])
        : []),
    ].some((file) => {
      const selected = parseSqliteSessionFileMarker(file);
      return (
        !selected ||
        selected.agentId !== agentId ||
        path.resolve(selected.storePath) !== databasePath ||
        (target && selected.sessionId !== target.sessionId)
      );
    })
  ) {
    throw new Error("Usage request contains another incognito session");
  }
  const observation =
    capturedOperation.kind === "refresh"
      ? undefined
      : createUsageCostIncognitoReadObservation(incognito);
  const result = await incognito.actor.sessions.withCompute(
    incognito.authority,
    target,
    async (compute) => {
      const instances = target
        ? [{ ...target, updatedAtMs: 0 }]
        : await compute.execute({ type: "session.compute.store.inventory", input: {} });
      instances.forEach(({ sessionKey }) => {
        incognito.retainSource?.(sessionKey);
      });
      return runPreparedUsageCostWorker(
        captured,
        capturedOperation,
        createIncognitoUsageCostAdapter(compute, target, marker, instances),
      );
    },
    operation.kind === "refresh" ? undefined : (incognito.admissionSignal ?? getAsyncWorkSignal()),
    observation?.onRead,
  );
  observation?.assertCurrent();
  return result;
}

async function runPreparedUsageCostWorker(
  prepared: PreparedUsageCostWorker,
  operation: UsageCostWorkerRequest,
  incognito?: ReturnType<typeof createIncognitoUsageCostAdapter>,
): Promise<UsageCostWorkerResult | { kind: "busy" }> {
  const location = structuredClone(prepared.location);
  const capturedOperation = structuredClone(operation);
  const signal = getAsyncWorkSignal();
  return withSessionCostUsageWorkerDatabases(prepared.databases, async (scope) => {
    const actorOwnsCache = incognito?.owns(location.agentId, location.databasePath) === true;
    const bindings = prepared.databases.map((options) => {
      const memory = isIncognitoOpenClawAgentSqlitePath(options.path, options);
      return {
        options,
        memory,
        database: memory && !incognito ? getOpenClawAgentDatabaseIfOpen(options) : undefined,
      };
    });
    const assertCurrent = () => {
      incognito?.assertCurrent();
      scope.assertCurrent();
      signal?.throwIfAborted();
    };
    const resolveBinding = (
      target: Pick<SqliteSessionFileMarker, "agentId" | "storePath">,
      memoryOnly = false,
    ) => {
      const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env: location.env }));
      const databasePath = resolveOpenClawAgentSqlitePath(options);
      const binding = bindings.find(
        (entry) => entry.options.agentId === options.agentId && entry.options.path === databasePath,
      );
      if (!binding) {
        throw new Error("Usage worker requested an unowned transcript database");
      }
      if (memoryOnly && !binding.memory) {
        throw new Error("Usage worker requested an unowned memory database");
      }
      if (binding.memory && !incognito) {
        binding.database ??= getOpenClawAgentDatabaseIfOpen(binding.options);
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
    const hostLock =
      capturedOperation.kind === "refresh" && !actorOwnsCache
        ? prepareSessionCostUsageRefreshLock(location.agentId, location.databasePath, {
            env: location.env,
            assertCurrent,
          })
        : undefined;
    if (hostLock) {
      scope.retainCleanup(hostLock.release);
    }
    const lock =
      capturedOperation.kind === "refresh"
        ? actorOwnsCache
          ? incognito?.lock
          : hostLock
        : undefined;
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
    let activeSessionFile: string | undefined;
    const hostErrors = new Map<number, unknown>();
    let errorSequence = 0;
    try {
      const failureEntries =
        lock && !incognito
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
          transcriptFiles: incognito?.filePaths,
        },
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
              let output: UsageCostWorkerHostEffects[keyof UsageCostWorkerHostEffects]["output"] =
                undefined;
              if (incognito && request.kind.startsWith("memory-")) {
                output = await incognito.read(request, context.signal);
              } else {
                switch (request.kind) {
                  case "refresh-session":
                    requireLock("refresh sessions");
                    activeSessionFile = request.input.sessionFile;
                    break;
                  case "pricing":
                    output = request.input.map(resolveCost);
                    break;
                  case "restore": {
                    if (incognito) {
                      throw new Error("Incognito transcripts have no cold storage");
                    }
                    const binding = resolveBinding(request.input);
                    await restoreSessionColdTranscript(
                      { ...request.input, storePath: binding.options.path, env: location.env },
                      assertRequestCurrent,
                      undefined,
                      undefined,
                      context.signal,
                    );
                    break;
                  }
                  case "memory-instances": {
                    const binding = resolveBinding(request.input, true);
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
                      const binding = resolveBinding(marker, true);
                      return binding.database
                        ? readTranscriptStatsBatchFromDatabase(binding.database, [
                            marker.sessionId,
                          ])[0]
                        : undefined;
                    });
                    break;
                  case "memory-cache": {
                    const binding = resolveBinding(
                      { agentId: location.agentId, storePath: location.databasePath },
                      true,
                    );
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
                    const binding = resolveBinding(request.input.marker, true);
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
                    const binding = resolveBinding(
                      { agentId: location.agentId, storePath: location.databasePath },
                      true,
                    );
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
                    requireLock("prune cache rows");
                    pruneRows.push({
                      key: request.input.key,
                      valueJson: request.input.value,
                      updatedAt: request.input.updatedAt,
                    });
                    break;
                  case "prune":
                    await requireLock("prune cache rows").pruneRows(pruneRows, context.signal);
                    pruneRows.length = 0;
                    break;
                  case "write":
                    output = await requireLock("write cache rows").writeRollup(
                      {
                        rollupId: request.input.key,
                        previousValueJson: request.input.previousValue,
                        valueJson: request.input.value,
                        blob: request.input.blob,
                        updatedAt: request.input.updatedAt,
                      },
                      context.signal,
                    );
                    if (output && failedKeys.has(failureKey(request.input.key))) {
                      await failures
                        .delete(failureKey(request.input.key), {
                          assertCurrent: assertRequestCurrent,
                          signal: context.signal,
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
      if (activeSessionFile && !signal?.aborted && !incognito) {
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
