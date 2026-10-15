import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { getAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { isAbortError } from "./abort-signal.js";
import { observeAgentRunActivity } from "./agent-run-activity.js";
import { formatErrorMessage } from "./errors.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import { isSessionActorUsageRefreshRunning } from "./session-cost-usage-memory.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import {
  prepareUsageCostWorker,
  resolveUsageCostWorkerDayBucket,
  runUsageCostWorker,
  type PreparedUsageCostWorker,
} from "./session-cost-usage-worker-runtime.js";
import type { UsageCostWorkerResult } from "./session-cost-usage-worker.types.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  UsageCacheStatus,
  UsageCostTranscriptFile,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const USAGE_COST_REFRESH_RETRY_MIN_MS = 50;
const USAGE_COST_PUBLICATION_QUIET_MS = 30_000;
const USAGE_COST_PUBLICATION_MAX_WAIT_MS = 5 * 60_000;
const USAGE_COST_REFRESH_BATCH_SIZE = 50;
const USAGE_COST_REFRESH_RETRY_MAX_MS = 5_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId: string;
  config?: OpenClawConfig;
  databasePath: string;
  queueKey: string;
  env?: NodeJS.ProcessEnv;
  sessionActor?: SessionActorStorageBinding;
  fullRefreshRequested: boolean;
  pendingSessionFiles: Map<string, { firstAt: number; lastAt: number } | null>;
  pendingRebuildRows: Map<string, SessionCostUsageRollupRow>;
  storePath: string;
  dirtySessionFiles: Set<string>;
  readingSessionFiles: Map<string, Deferred>;
  runningSessionFiles: Set<string> | "all";
  agentBusy: boolean;
  idleAt: number;
  resume?: () => void;
};

type UsageCostRefreshRequest = Pick<UsageCostRefreshState, "agentId" | "config" | "storePath"> & {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  sessionActor?: SessionActorStorageBinding;
  sessionFiles?: string[];
  rebuildRows?: SessionCostUsageRollupRow[];
  /** Defer transcript publications to an idle gap; on-demand reads flush them. */
  coalesce?: boolean;
};

// Only active queues retain their scope; one owner cannot adopt another owner's work.
const usageCostRefreshes = new Map<AbortSignal | undefined, Map<string, UsageCostRefreshState>>();

function isUsageCostRefreshQueued(databasePath: string): boolean {
  return usageCostRefreshes.get(getAsyncWorkSignal())?.has(databasePath) === true;
}

async function flushPendingUsageCostRefresh(
  prepared: PreparedUsageCostWorker,
  sessionFiles?: string[],
  maxPublicationWaitMs = Infinity,
): Promise<void> {
  const signal = getAsyncWorkSignal();
  signal?.throwIfAborted();
  const key = prepared.location.databasePath;
  const pending: Promise<void>[] = [];
  for (const refreshes of usageCostRefreshes.values()) {
    const state = refreshes.get(key);
    if (!state) {
      continue;
    }
    // Aggregate reads flush dirty publications; keyed reads need only their sessions.
    for (const file of sessionFiles ?? state.dirtySessionFiles) {
      if (
        !state.fullRefreshRequested &&
        state.runningSessionFiles !== "all" &&
        !state.runningSessionFiles.has(file) &&
        !state.pendingSessionFiles.has(file)
      ) {
        continue;
      }
      let completion = state.readingSessionFiles.get(file);
      if (!completion) {
        completion = createDeferredCore();
        state.readingSessionFiles.set(file, completion);
      }
      if (state.runningSessionFiles === "all" || !state.runningSessionFiles.has(file)) {
        state.pendingSessionFiles.set(file, null);
      }
      pending.push(completion.promise);
    }
    state.resume?.();
  }
  if (pending.length === 0) {
    return;
  }
  // Reports can serve the last committed projection after their wait budget;
  // exact reads keep awaiting their selected sessions. Publication owns the refresh.
  const waiting = new AbortController();
  const stopWaiting = () => waiting.abort();
  signal?.addEventListener("abort", stopWaiting, { once: true });
  try {
    await Promise.race([
      Promise.all(pending),
      waitForUsageCostRefresh(waiting.signal, maxPublicationWaitMs),
    ]);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", stopWaiting);
    stopWaiting();
  }
}

export async function loadCostUsageSummary(params: {
  startMs?: number;
  endMs?: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId: string;
}): Promise<CostUsageSummary> {
  const now = Date.now();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 29);
  return loadAggregateCostUsageSummary(
    {
      ...params,
      startMs: params.startMs ?? defaultStart.getTime(),
      endMs: params.endMs ?? now,
    },
    true,
  );
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId: string;
  requestRefresh?: boolean;
}): Promise<CostUsageSummary> {
  return loadAggregateCostUsageSummary(params, false);
}

async function loadAggregateCostUsageSummary(
  params: Parameters<typeof loadCostUsageSummaryFromCache>[0],
  refreshFirst: boolean,
): Promise<CostUsageSummary> {
  const prepared = prepareUsageCostWorker(params);
  const { databasePath, storePath } = prepared.location;
  await flushPendingUsageCostRefresh(prepared);
  const refresh = refreshFirst
    ? await refreshCostUsageCacheForAgent({
        config: params.config,
        agentId: params.agentId,
        agentDir: prepared.agentDir,
        databasePath,
        storePath,
        sessionActor: prepared.sessionActor,
      })
    : undefined;
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    prepared.config,
    prepared.agentDir,
  );
  const result = await runUsageCostWorker(prepared, {
    pricingFingerprint,
    startMs: params.startMs,
    endMs: params.endMs,
    dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
    kind: "summary",
  });
  if (result.kind !== "summary" || !result.summary.cacheStatus) {
    throw new Error("Usage worker returned an invalid aggregate summary");
  }
  const { summary, invalidRows } = result;
  const cacheStatus = result.summary.cacheStatus;
  if (
    refreshFirst
      ? invalidRows.length > 0
      : params.requestRefresh !== false && cacheStatus.staleFiles > 0
  ) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      storePath,
      rebuildRows: invalidRows,
      sessionActor: prepared.sessionActor,
    });
  }
  if (
    refresh === "busy" ||
    isUsageCostRefreshQueued(databasePath) ||
    (prepared.memory
      ? isSessionActorUsageRefreshRunning(prepared.memory)
      : await isSessionCostUsageRefreshRunning(params.agentId, databasePath))
  ) {
    cacheStatus.status = "refreshing";
  }
  summary.updatedAt = Date.now();
  return summary;
}

type SessionCostReadParams = {
  sessions: Array<{
    sessionId?: string;
    sessionFile: string;
    transcriptFile?: UsageCostTranscriptFile;
  }>;
  config?: OpenClawConfig;
  agentId: string;
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  requestRefresh?: boolean;
  maxPublicationWaitMs?: number;
  reportBudgetBytes?: number;
};

export async function loadSessionCostSummariesFromCache(params: SessionCostReadParams): Promise<{
  summaries: Array<SessionCostSummary | null>;
  cacheStatus: UsageCacheStatus;
  remainingReportBytes?: number;
}> {
  const result = await loadSessionCostResultFromCache(params);
  if (result.kind !== "sessions") {
    throw new Error("Usage worker returned an invalid session summary");
  }
  return {
    summaries: result.summaries,
    cacheStatus: result.cacheStatus,
    remainingReportBytes: result.remainingReportBytes,
  };
}

function loadSessionCostResultFromCache(params: SessionCostReadParams) {
  const prepared = prepareUsageCostWorker({
    ...params,
    sessionFiles: params.sessions.map((session) => session.sessionFile),
  });
  return loadCapturedSessionCostSummariesFromCache(params, prepared);
}

async function loadCapturedSessionCostSummariesFromCache(
  params: SessionCostReadParams,
  prepared: PreparedUsageCostWorker,
): Promise<Extract<UsageCostWorkerResult, { kind: "sessions" }>> {
  const { databasePath, storePath } = prepared.location;
  await flushPendingUsageCostRefresh(
    prepared,
    params.sessions.map((session) => session.sessionFile),
    params.maxPublicationWaitMs,
  );
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    prepared.config,
    prepared.agentDir,
  );
  const result = await runUsageCostWorker(prepared, {
    kind: "sessions",
    pricingFingerprint,
    sessions: params.sessions,
    startMs: params.startMs,
    endMs: params.endMs,
    includeUntimestamped: params.includeUntimestamped,
    reportBudgetBytes: params.reportBudgetBytes,
    dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
  });
  if (result.kind !== "sessions") {
    throw new Error("Usage worker returned an invalid session summary");
  }
  const { cacheStatus, staleSessionFiles } = result;
  const refreshRequested = params.requestRefresh !== false && staleSessionFiles.length > 0;
  if (refreshRequested) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      storePath,
      sessionFiles: staleSessionFiles,
      rebuildRows: result.invalidRows,
      databasePath,
      env: prepared.location.env,
      sessionActor: prepared.sessionActor,
    });
  }
  if (
    staleSessionFiles.length > 0 &&
    (refreshRequested ||
      (prepared.memory
        ? isSessionActorUsageRefreshRunning(prepared.memory)
        : await isSessionCostUsageRefreshRunning(params.agentId, databasePath)))
  ) {
    cacheStatus.status = "refreshing";
    for (const summary of result.summaries) {
      if (summary?.staleSince !== undefined) {
        summary.refreshing = true;
      }
    }
  }
  return result;
}

export function requestCostUsageCacheRefresh(params: UsageCostRefreshRequest): void {
  const scopeSignal = getAsyncWorkSignal();
  if (scopeSignal?.aborted) {
    return;
  }
  const databasePath =
    params.sessionActor?.path ??
    resolveOpenClawAgentSqlitePath({
      agentId: normalizeAgentId(params.agentId),
      path: params.databasePath,
      env: params.env,
    });
  // Purge publications must not start rebuildable cache work in the retiring database.
  if (
    getAgentDeletionDatabaseCleanup({
      agentId: params.agentId,
      path: databasePath,
      env: params.env,
    })?.ownsDatabase
  ) {
    return;
  }
  const queueKey = databasePath;
  const refreshes = usageCostRefreshes.get(scopeSignal) ?? new Map<string, UsageCostRefreshState>();
  const existing = refreshes.get(queueKey);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    existing.resume?.();
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params.agentId,
    config: params.config,
    databasePath,
    queueKey,
    env: params.env,
    sessionActor: params.sessionActor,
    fullRefreshRequested: false,
    pendingSessionFiles: new Map(),
    pendingRebuildRows: new Map(),
    storePath: params.storePath,
    dirtySessionFiles: new Set(),
    readingSessionFiles: new Map(),
    runningSessionFiles: new Set(),
    agentBusy: false,
    idleAt: Date.now(),
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(scopeSignal, refreshes);
  // Register the initial timer and every retry now, not after a timer fires.
  refreshes.set(queueKey, state);
  void trackAsyncWork(() => runQueuedUsageCostRefresh(state, refreshes, scopeSignal));
}

function mergeUsageCostRefreshRequest(
  state: UsageCostRefreshState,
  params: UsageCostRefreshRequest,
): void {
  state.config = params.config ?? state.config;
  state.agentId = params.agentId;
  state.storePath = params.storePath;
  for (const row of params.rebuildRows ?? []) {
    state.pendingRebuildRows.set(row.key, row);
    state.pendingSessionFiles.set(row.key, null);
  }
  if (!params.sessionFiles) {
    state.fullRefreshRequested = true;
    return;
  }
  const now = Date.now();
  for (const sessionFile of params.sessionFiles) {
    if (params.coalesce) {
      state.dirtySessionFiles.add(sessionFile);
    }
    const pending = state.pendingSessionFiles.get(sessionFile);
    state.pendingSessionFiles.set(
      sessionFile,
      params.coalesce && pending !== null
        ? { firstAt: pending?.firstAt ?? now, lastAt: now }
        : null,
    );
  }
}

function usageCostRefreshDelay(state: UsageCostRefreshState, now: number, file?: string): number {
  if (
    (file === undefined && (state.readingSessionFiles.size > 0 || state.fullRefreshRequested)) ||
    (file !== undefined && state.readingSessionFiles.has(file))
  ) {
    return 0;
  }
  const delays =
    file === undefined
      ? state.pendingSessionFiles.entries()
      : [[file, state.pendingSessionFiles.get(file)] as const];
  let delay = Infinity;
  for (const [pendingFile, pending] of delays) {
    if (state.agentBusy && state.dirtySessionFiles.has(pendingFile)) {
      continue;
    }
    if (!pending) {
      return 0;
    }
    delay = Math.min(
      delay,
      Math.min(
        pending.firstAt + USAGE_COST_PUBLICATION_MAX_WAIT_MS,
        Math.max(pending.lastAt, state.idleAt) + USAGE_COST_PUBLICATION_QUIET_MS,
      ) - now,
    );
  }
  return Math.max(0, delay);
}

function waitForUsageCostRefresh(
  signal: AbortSignal | undefined,
  delayMs: number,
  state?: UsageCostRefreshState,
): Promise<void> {
  return new Promise((resolve) => {
    // Zero must remain a real timer so cache reads return before refresh starts.
    const timer = Number.isFinite(delayMs) ? setTimeout(finish, delayMs) : undefined;
    timer?.unref?.();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      if (state) {
        state.resume = undefined;
      }
      resolve();
    }
    if (state) {
      state.resume = finish;
    }
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

async function runQueuedUsageCostRefresh(
  state: UsageCostRefreshState,
  refreshes: Map<string, UsageCostRefreshState>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
  let retryAt = 0;
  let recoveredPartialFailure = false;
  const offActivity = observeAgentRunActivity(state.agentId, (busy) => {
    state.agentBusy = busy;
    if (!busy) {
      state.idleAt = Date.now();
    }
    state.resume?.();
  });
  try {
    do {
      await waitForUsageCostRefresh(
        signal,
        Math.max(retryAt - Date.now(), usageCostRefreshDelay(state, Date.now())),
        state,
      );
      if (signal?.aborted) {
        return;
      }
      if (Date.now() < retryAt || usageCostRefreshDelay(state, Date.now()) > 0) {
        continue;
      }
      let partialBatch = false;
      try {
        if (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
          const priorityFiles = [...state.readingSessionFiles.keys()];
          const fullRefreshRequested = state.fullRefreshRequested && priorityFiles.length === 0;
          partialBatch = !fullRefreshRequested;
          const sessionFiles: string[] = [];
          if (fullRefreshRequested) {
            // Keep dirty publications explicit: discovery may leave them beyond its batch.
            for (const file of state.pendingSessionFiles.keys()) {
              if (!state.dirtySessionFiles.has(file)) {
                state.pendingSessionFiles.delete(file);
              }
            }
          } else {
            for (const file of priorityFiles.length
              ? priorityFiles
              : state.pendingSessionFiles.keys()) {
              if (usageCostRefreshDelay(state, Date.now(), file) > 0) {
                continue;
              }
              sessionFiles.push(file);
              state.pendingSessionFiles.delete(file);
              if (sessionFiles.length === USAGE_COST_REFRESH_BATCH_SIZE) {
                break;
              }
            }
          }
          // Caller selectors can differ from canonical keys; the worker matches repair facts.
          const rebuildRows = [...state.pendingRebuildRows.values()];
          if (fullRefreshRequested) {
            state.fullRefreshRequested = false;
          }
          state.runningSessionFiles = fullRefreshRequested ? "all" : new Set(sessionFiles);
          const remainingRollupIds = new Set<string>();
          const result = await refreshCostUsageCacheForAgent({
            config: state.config,
            agentId: state.agentId,
            databasePath: state.databasePath,
            storePath: state.storePath,
            sessionFiles: fullRefreshRequested ? undefined : sessionFiles,
            maxFiles: USAGE_COST_REFRESH_BATCH_SIZE,
            onRemaining: (files) => {
              for (const { sessionFile, rollupId } of files) {
                remainingRollupIds.add(rollupId);
                state.pendingSessionFiles.set(sessionFile, null);
                if (state.pendingRebuildRows.has(rollupId)) {
                  state.pendingSessionFiles.set(rollupId, null);
                }
              }
            },
            rebuildRows,
            env: state.env,
            sessionActor: state.sessionActor,
          });
          if (signal?.aborted) {
            return;
          }
          if (result === "busy") {
            if (fullRefreshRequested) {
              state.fullRefreshRequested = true;
            } else {
              state.pendingSessionFiles = new Map([
                ...sessionFiles.map((file) => [file, null] as const),
                ...state.pendingSessionFiles,
              ]);
            }
            retryAt = Date.now() + busyRetryDelayMs;
            // Contention among many per-agent refreshes must degrade to polling, not a 20Hz spin.
            busyRetryDelayMs = Math.min(busyRetryDelayMs * 2, USAGE_COST_REFRESH_RETRY_MAX_MS);
            continue;
          }
          for (const row of rebuildRows) {
            if (
              (fullRefreshRequested || sessionFiles.includes(row.key)) &&
              !remainingRollupIds.has(row.key) &&
              state.pendingRebuildRows.get(row.key) === row
            ) {
              state.pendingRebuildRows.delete(row.key);
            }
          }
          for (const file of sessionFiles) {
            // A publication during the scan needs another pass before this read is exact.
            if (!state.pendingSessionFiles.has(file)) {
              state.dirtySessionFiles.delete(file);
              state.readingSessionFiles.get(file)?.resolve();
              state.readingSessionFiles.delete(file);
            }
          }
          state.runningSessionFiles = new Set();
          busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
        }
      } catch (error) {
        if (signal?.aborted && !(error instanceof AggregateError) && isAbortError(error)) {
          logger.debug("background refresh cancelled during shutdown");
          return;
        }
        logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
        if (signal?.aborted || !partialBatch || recoveredPartialFailure) {
          return;
        }
        // A queued identity can disappear on reset or deletion. Rediscover once;
        // persistent failures wait for the next publication instead of spinning.
        recoveredPartialFailure = true;
        state.fullRefreshRequested = true;
        for (const file of state.readingSessionFiles.keys()) {
          state.pendingSessionFiles.set(file, null);
        }
      }
    } while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0);
  } finally {
    offActivity();
    for (const completion of state.readingSessionFiles.values()) {
      completion.reject(
        new Error("Usage refresh ended before the requested session was refreshed"),
      );
    }
    // Remove synchronously with completion; a late request must enqueue a new owner.
    refreshes.delete(state.queueKey);
    if (refreshes.size === 0) {
      usageCostRefreshes.delete(signal);
    }
  }
}
