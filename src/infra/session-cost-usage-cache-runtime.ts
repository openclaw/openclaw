import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { formatErrorMessage } from "./errors.js";
import {
  refreshCostUsageCacheForAgent,
  resolveUsageCostCacheDatabasePath,
} from "./session-cost-usage-aggregation.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import {
  prepareUsageCostWorker,
  resolveUsageCostWorkerDayBucket,
  runUsageCostWorker,
  type PreparedUsageCostWorker,
} from "./session-cost-usage-worker-runtime.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  UsageCacheStatus,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const USAGE_COST_REFRESH_RETRY_MIN_MS = 50;
const USAGE_COST_REFRESH_RETRY_MAX_MS = 5_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId: string;
  config?: OpenClawConfig;
  databasePath: string;
  fullRefreshRequested: boolean;
  fullRefreshStartMs?: number;
  pendingSessionFiles: Set<string>;
  pendingRebuildRows: Map<string, SessionCostUsageRollupRow>;
  storePath: string;
};

type UsageCostRefreshRequest = Pick<UsageCostRefreshState, "agentId" | "config" | "storePath"> & {
  sessionFiles?: string[];
  startMs?: number;
  rebuildRows?: SessionCostUsageRollupRow[];
};

// Only active queues retain their scope; one owner cannot adopt another owner's work.
const usageCostRefreshes = new Map<AbortSignal | undefined, Map<string, UsageCostRefreshState>>();

function isUsageCostRefreshQueued(databasePath: string): boolean {
  return usageCostRefreshes.get(getAsyncWorkSignal())?.has(databasePath) === true;
}

async function readCostUsageSummaryFromWorker(
  prepared: PreparedUsageCostWorker,
  params: {
    pricingFingerprint: string;
    startMs: number;
    endMs: number;
    dayBucket?: UsageDailyBucket;
  },
) {
  const result = await runUsageCostWorker(prepared, {
    ...params,
    kind: "summary",
    dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
  });
  if (result.kind !== "summary" || !result.summary.cacheStatus) {
    throw new Error("Usage worker returned an invalid aggregate summary");
  }
  return {
    summary: result.summary,
    cacheStatus: result.summary.cacheStatus,
    invalidRows: result.invalidRows,
  };
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
  const startMs = params.startMs ?? defaultStart.getTime();
  const endMs = params.endMs ?? now;
  const prepared = prepareUsageCostWorker(params);
  const { databasePath, storePath } = prepared.location;
  const result = await refreshCostUsageCacheForAgent({
    config: params.config,
    agentId: params.agentId,
    agentDir: prepared.agentDir,
    databasePath,
    storePath,
    startMs,
  });
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    prepared.config,
    prepared.agentDir,
  );
  const { summary, cacheStatus, invalidRows } = await readCostUsageSummaryFromWorker(prepared, {
    pricingFingerprint,
    startMs,
    endMs,
    dayBucket: params.dayBucket,
  });
  if (invalidRows.length > 0) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      storePath,
      startMs,
      rebuildRows: invalidRows,
    });
  }
  if (
    result === "busy" ||
    isUsageCostRefreshQueued(databasePath) ||
    (await isSessionCostUsageRefreshRunning(params.agentId, databasePath))
  ) {
    cacheStatus.status = "refreshing";
  }
  summary.updatedAt = Date.now();
  return summary;
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId: string;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary> {
  const prepared = prepareUsageCostWorker(params);
  const { databasePath, storePath } = prepared.location;
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    prepared.config,
    prepared.agentDir,
  );
  const request = {
    pricingFingerprint,
    startMs: params.startMs,
    endMs: params.endMs,
    dayBucket: params.dayBucket,
  };
  let snapshot = await readCostUsageSummaryFromWorker(prepared, request);
  if (params.requestRefresh !== false && snapshot.cacheStatus.staleFiles > 0) {
    if (params.refreshMode === "sync-when-empty" && snapshot.cacheStatus.cachedFiles === 0) {
      const result = await refreshCostUsageCacheForAgent({
        config: params.config,
        agentId: params.agentId,
        agentDir: prepared.agentDir,
        storePath,
        startMs: params.startMs,
        rebuildRows: snapshot.invalidRows,
      });
      snapshot = await readCostUsageSummaryFromWorker(prepared, request);
      if (result === "refreshed" && snapshot.cacheStatus.staleFiles > 0) {
        requestCostUsageCacheRefresh({
          config: params.config,
          agentId: params.agentId,
          storePath,
          startMs: params.startMs,
          rebuildRows: snapshot.invalidRows,
        });
      }
    } else {
      requestCostUsageCacheRefresh({
        config: params.config,
        agentId: params.agentId,
        storePath,
        startMs: params.startMs,
        rebuildRows: snapshot.invalidRows,
      });
    }
  }
  if (
    isUsageCostRefreshQueued(databasePath) ||
    (await isSessionCostUsageRefreshRunning(params.agentId, databasePath))
  ) {
    snapshot.cacheStatus.status = "refreshing";
  }
  snapshot.summary.updatedAt = Date.now();
  return snapshot.summary;
}

export async function loadSessionCostSummariesFromCache(params: {
  sessions: Array<{ sessionId?: string; sessionFile: string }>;
  config?: OpenClawConfig;
  agentId: string;
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  requestRefresh?: boolean;
}): Promise<{ summaries: Array<SessionCostSummary | null>; cacheStatus: UsageCacheStatus }> {
  const prepared = prepareUsageCostWorker({
    ...params,
    sessionFiles: params.sessions.map((session) => session.sessionFile),
  });
  const { databasePath, storePath } = prepared.location;
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
    dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
  });
  if (result.kind !== "sessions") {
    throw new Error("Usage worker returned an invalid session summary");
  }
  const { summaries, cacheStatus, staleSessionFiles } = result;
  const refreshRequested = params.requestRefresh !== false && staleSessionFiles.length > 0;
  if (refreshRequested) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      storePath,
      sessionFiles: staleSessionFiles,
      rebuildRows: result.invalidRows,
    });
  }
  const refreshRunning = await isSessionCostUsageRefreshRunning(params.agentId, databasePath);
  if (staleSessionFiles.length > 0 && (refreshRunning || refreshRequested)) {
    cacheStatus.status = "refreshing";
    for (const summary of summaries) {
      if (summary?.staleSince !== undefined) {
        summary.refreshing = true;
      }
    }
  }
  return { summaries, cacheStatus };
}

function requestCostUsageCacheRefresh(params: UsageCostRefreshRequest): void {
  const scopeSignal = getAsyncWorkSignal();
  if (scopeSignal?.aborted) {
    return;
  }
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const refreshes = usageCostRefreshes.get(scopeSignal) ?? new Map<string, UsageCostRefreshState>();
  const existing = refreshes.get(databasePath);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params.agentId,
    config: params.config,
    databasePath,
    fullRefreshRequested: false,
    pendingSessionFiles: new Set(),
    pendingRebuildRows: new Map(),
    storePath: params.storePath,
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(scopeSignal, refreshes);
  // Register the initial timer and every retry now, not after a timer fires.
  refreshes.set(databasePath, state);
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
  }
  if (!params.sessionFiles) {
    state.fullRefreshStartMs = state.fullRefreshRequested
      ? state.fullRefreshStartMs === undefined || params.startMs === undefined
        ? undefined
        : Math.min(state.fullRefreshStartMs, params.startMs)
      : params.startMs;
    state.fullRefreshRequested = true;
    return;
  }
  for (const sessionFile of params.sessionFiles) {
    state.pendingSessionFiles.add(sessionFile);
  }
}

function waitForUsageCostRefresh(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    // Zero must remain a real timer so cache reads return before refresh starts.
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
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
  let retryDelayMs = 0;
  try {
    do {
      await waitForUsageCostRefresh(signal, retryDelayMs);
      if (signal?.aborted) {
        return;
      }
      retryDelayMs = 0;
      try {
        while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
          const fullRefreshRequested = state.fullRefreshRequested;
          const fullRefreshStartMs = state.fullRefreshStartMs;
          const sessionFiles = fullRefreshRequested ? [] : [...state.pendingSessionFiles];
          const rebuildRows = [...state.pendingRebuildRows.values()];
          state.pendingRebuildRows.clear();
          if (!fullRefreshRequested) {
            state.pendingSessionFiles.clear();
          }
          state.fullRefreshRequested = false;
          state.fullRefreshStartMs = undefined;
          const result = await refreshCostUsageCacheForAgent({
            config: state.config,
            agentId: state.agentId,
            databasePath: state.databasePath,
            storePath: state.storePath,
            sessionFiles: fullRefreshRequested ? undefined : sessionFiles,
            startMs: fullRefreshRequested ? fullRefreshStartMs : undefined,
            rebuildRows,
          });
          if (signal?.aborted) {
            return;
          }
          if (result === "busy") {
            for (const row of rebuildRows) {
              if (!state.pendingRebuildRows.has(row.key)) {
                state.pendingRebuildRows.set(row.key, row);
              }
            }
            if (fullRefreshRequested) {
              mergeUsageCostRefreshRequest(state, {
                agentId: state.agentId,
                config: state.config,
                storePath: state.storePath,
                startMs: fullRefreshStartMs,
                rebuildRows,
              });
            } else {
              for (const sessionFile of sessionFiles) {
                state.pendingSessionFiles.add(sessionFile);
              }
            }
            retryDelayMs = busyRetryDelayMs;
            // Contention among many per-agent refreshes must degrade to polling, not a 20Hz spin.
            busyRetryDelayMs = Math.min(busyRetryDelayMs * 2, USAGE_COST_REFRESH_RETRY_MAX_MS);
            break;
          }
          busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
        }
      } catch (error) {
        logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
        if (signal?.aborted) {
          return;
        }
      }
    } while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0);
  } finally {
    // Remove synchronously with completion; a late request must enqueue a new owner.
    refreshes.delete(state.databasePath);
    if (refreshes.size === 0) {
      usageCostRefreshes.delete(signal);
    }
  }
}
