import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../../../src/cron/service/list-page-validation.js";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type { CronJobsState } from "./types.ts";

function queueCronJobsSnapshotRecovery<Row>(state: CronJobsState<Row>, tableFilters: boolean) {
  if (state.cronJobsReloadPending) {
    return;
  }
  state.cronJobsReloadPending = true;
  state.cronJobsReloadPendingTableFilters = tableFilters;
}

async function drainPendingCronJobsReload<Row extends CronInventoryJob>(
  state: CronJobsState<Row>,
  projection: CronJobsProjection<Row>,
) {
  if (!state.cronJobsReloadPending) {
    return;
  }
  const tableFilters = state.cronJobsReloadPendingTableFilters;
  state.cronJobsReloadPending = false;
  state.cronJobsReloadPendingTableFilters = false;
  await loadCronJobsProjectionPage(state, projection, { tableFilters });
}

type CronInventoryJob = Pick<CronJob, "id" | "name" | "agentId" | "enabled" | "updatedAtMs">;
type CronRuntimeState = Pick<
  CronJob["state"],
  | "nextRunAtMs"
  | "lastRunAtMs"
  | "lastRunStatus"
  | "lastStatus"
  | "runningAtMs"
  | "autoDisabled"
  | "lastError"
  | "lastDurationMs"
>;

export type CronJobsPageOptions = { append?: boolean; tableFilters?: boolean; event?: unknown };
export type CronJobsProjection<Row extends CronInventoryJob> = {
  compact?: true;
  readRows?: (rows: Row[]) => Row[];
  applyRuntime: (
    state: CronJobsState<Row>,
    index: number,
    update: { updatedAtMs: number; runtime: CronRuntimeState; finished: boolean },
  ) => boolean;
};

const cronInventoryScopes = new WeakMap<
  CronJobsState<unknown>,
  CronJobsState["cronAgentId" | "cronSessionFilter"]
>();
const cronInventoryRequests = new WeakMap<CronJobsState<unknown>, object>();

export function retireCronJobsRequest(state: CronJobsState<unknown>) {
  cronInventoryRequests.delete(state);
  state.cronLoading = false;
  state.cronJobsLoadingMore = false;
}

function isCronInventoryTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasCompactCronInventoryFacts(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const autoDisabled = value.autoDisabled;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    (value.agentId === undefined || typeof value.agentId === "string") &&
    typeof value.enabled === "boolean" &&
    isCronInventoryTimestamp(value.updatedAtMs) &&
    (value.nextRunAtMs === null || isCronInventoryTimestamp(value.nextRunAtMs)) &&
    (value.lastRunAtMs === null || isCronInventoryTimestamp(value.lastRunAtMs)) &&
    (value.lastRunStatus === null ||
      value.lastRunStatus === "ok" ||
      value.lastRunStatus === "error" ||
      value.lastRunStatus === "skipped") &&
    (value.runningAtMs === undefined || isCronInventoryTimestamp(value.runningAtMs)) &&
    (autoDisabled === undefined ||
      (isRecord(autoDisabled) &&
        (autoDisabled.reason === "consecutive-failures" ||
          autoDisabled.reason === "schedule-errors") &&
        isCronInventoryTimestamp(autoDisabled.atMs) &&
        typeof autoDisabled.consecutiveErrors === "number" &&
        Number.isSafeInteger(autoDisabled.consecutiveErrors) &&
        autoDisabled.consecutiveErrors > 0))
  );
}

const compactCronJobsProjection: CronJobsProjection<CronCompactJob> = {
  compact: true,
  readRows: (rows) => {
    // A partial inventory cannot establish absence or retire dismissed alerts.
    if (!rows.every(hasCompactCronInventoryFacts)) {
      throw new Error("cron.list returned an invalid compact inventory row");
    }
    return rows;
  },
  applyRuntime: (state, index, { updatedAtMs, runtime, finished }) => {
    // Runtime facts preserve name order; other compact orderings need an authoritative page.
    if (state.cronJobsSortBy !== "name") {
      return false;
    }
    const { nextRunAtMs, lastRunAtMs, lastRunStatus, lastStatus, runningAtMs, autoDisabled } =
      runtime;
    state.cronJobs = state.cronJobs.with(index, {
      ...state.cronJobs[index]!,
      updatedAtMs,
      nextRunAt: timestampMsToIsoString(nextRunAtMs) ?? null,
      nextRunAtMs: nextRunAtMs ?? null,
      lastRunAt: timestampMsToIsoString(lastRunAtMs) ?? null,
      lastRunAtMs: lastRunAtMs ?? null,
      lastRunStatus: lastRunStatus ?? lastStatus ?? null,
      runningAtMs,
      autoDisabled,
      ...(finished ? { lastRunError: runtime.lastError ?? null } : {}),
    });
    return true;
  },
};

function applyCronJobsEvent<Row extends CronInventoryJob>(
  state: CronJobsState<Row>,
  projection: CronJobsProjection<Row>,
  payload: unknown,
): boolean {
  if (
    state.cronLoading ||
    state.cronJobsLoadingMore ||
    state.cronJobsReloadPending ||
    !state.cronJobsSnapshotRevision ||
    state.cronJobsError ||
    state.cronJobsHasMore ||
    state.cronJobs.length !== state.cronJobsTotal ||
    !(cronInventoryScopes.get(state) === (state.cronSessionFilter ?? state.cronAgentId)) ||
    state.cronJobsLastStatusFilter !== "all" ||
    !isRecord(payload) ||
    !["started", "finished", "scheduled"].includes(String(payload.action)) ||
    !isRecord(payload.job) ||
    !isRecord(payload.job.state) ||
    payload.jobId !== payload.job.id
  ) {
    return false;
  }
  // Definitions, unknown membership, filtered status and incomplete windows need a list read.
  const index = state.cronJobs.findIndex((job) => job.id === payload.jobId);
  const previous = state.cronJobs[index];
  if (
    !previous ||
    previous.name !== payload.job.name ||
    previous.agentId !== payload.job.agentId ||
    previous.enabled !== payload.job.enabled ||
    typeof payload.job.updatedAtMs !== "number"
  ) {
    return false;
  }
  if (payload.job.updatedAtMs < previous.updatedAtMs) {
    return true;
  }
  // SAFETY: The authenticated cron publisher owns this compact runtime projection.
  const runtime = payload.job.state as CronRuntimeState;
  const { nextRunAtMs, lastRunAtMs, lastRunStatus, lastStatus, runningAtMs, autoDisabled } =
    runtime;
  const finished = payload.action === "finished";
  return projection.applyRuntime(state, index, {
    updatedAtMs: payload.job.updatedAtMs,
    runtime: {
      nextRunAtMs,
      lastRunAtMs,
      lastRunStatus,
      lastStatus,
      runningAtMs,
      autoDisabled,
      ...(finished
        ? {
            lastError: typeof payload.error === "string" ? payload.error : undefined,
            lastDurationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
          }
        : {}),
    },
    finished,
  });
}

export function loadCompactCronJobsPage(
  state: CronJobsState<CronCompactJob>,
  opts?: CronJobsPageOptions,
) {
  return loadCronJobsProjectionPage(state, compactCronJobsProjection, opts);
}

export async function loadCronJobsProjectionPage<Row extends CronInventoryJob>(
  state: CronJobsState<Row>,
  projection: CronJobsProjection<Row>,
  opts?: CronJobsPageOptions,
) {
  if (!state.client || !state.connected || state.canRefresh?.() === false) {
    return;
  }
  if (opts?.event && applyCronJobsEvent(state, projection, opts.event)) {
    return;
  }
  const scope = state.cronSessionFilter ?? state.cronAgentId;
  const request = {};
  const isCurrentScope = () =>
    cronInventoryRequests.get(state) === request &&
    (state.cronSessionFilter ?? state.cronAgentId) === scope;
  // An editor can survive scope hydration; its inventory cannot. Retire both
  // retained rows and late responses before a failed replacement can expose them.
  if (cronInventoryScopes.has(state) && cronInventoryScopes.get(state) !== scope) {
    state.cronJobs = [];
    state.cronJobsSnapshotRevision = null;
    state.cronJobsTotal = 0;
    state.cronJobsHasMore = false;
    state.cronJobsNextOffset = null;
  }
  cronInventoryScopes.set(state, scope);
  const append = opts?.append === true;
  if (state.cronLoading || state.cronJobsLoadingMore) {
    if (!append) {
      state.cronJobsReloadPending = true;
      state.cronJobsReloadPendingTableFilters = opts?.tableFilters === true;
    }
    return;
  }
  if (append && !state.cronJobsHasMore) {
    return;
  }
  const loadingKey = append ? "cronJobsLoadingMore" : "cronLoading";
  cronInventoryRequests.set(state, request);
  state[loadingKey] = true;
  state.cronJobsError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult<Row>>("cron.list", {
      ...(state.cronSessionFilter ?? (state.cronAgentId ? { agentId: state.cronAgentId } : {})),
      includeDisabled: state.cronJobsEnabledFilter === "all",
      includeDeliveryPreviews: false,
      ...(projection.compact ? { compact: true } : {}),
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      ...(opts?.tableFilters
        ? {
            scheduleKind: state.cronJobsScheduleKindFilter,
            lastRunStatus: state.cronJobsLastStatusFilter,
            trigger: state.cronJobsTriggerFilter,
          }
        : {}),
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    if (!isCurrentScope()) {
      return;
    }
    const page = readCanonicalCronListPage<Row>(res, state.cronJobsLimit);
    if (
      append &&
      (page.snapshotRevision !== state.cronJobsSnapshotRevision ||
        page.total !== state.cronJobsTotal)
    ) {
      // A changed snapshot can move rows behind the append boundary. Preserve
      // the coherent table and let one serialized page-zero reload recover it.
      queueCronJobsSnapshotRecovery(state, opts?.tableFilters === true);
      return;
    }
    resolveCronListPageNextOffset(page, offset);
    const jobs = projection.readRows?.(page.jobs) ?? page.jobs;
    state.cronJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    state.cronJobsSnapshotRevision = page.snapshotRevision;
    state.cronJobsTotal = page.total;
    state.cronJobsHasMore = page.hasMore;
    state.cronJobsNextOffset = page.nextOffset;
    // A filtered/paged list is not deletion authority. Only an explicit remove
    // may clear an editor opened from an exact job definition.
  } catch (err) {
    if (isCurrentScope()) {
      state.cronJobsError = formatUiError(err);
    }
  } finally {
    if (cronInventoryRequests.get(state) === request) {
      cronInventoryRequests.delete(state);
      state[loadingKey] = false;
      await drainPendingCronJobsReload(state, projection);
    }
  }
}
