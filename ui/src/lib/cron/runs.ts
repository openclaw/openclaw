import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronDeliveryStatus,
  CronRunScope,
  CronRunsResult,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSortDir,
} from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type { CronState } from "./types.ts";

type CronRunsLoadStatus = "ok" | "error" | "skipped";

function normalizeCronRunsPageMeta(params: {
  totalRaw: unknown;
  offsetRaw: unknown;
  nextOffsetRaw: unknown;
  hasMoreRaw: unknown;
  pageCount: number;
}) {
  const total =
    typeof params.totalRaw === "number" && Number.isFinite(params.totalRaw)
      ? Math.max(0, Math.floor(params.totalRaw))
      : params.pageCount;
  const offset =
    typeof params.offsetRaw === "number" && Number.isFinite(params.offsetRaw)
      ? Math.max(0, Math.floor(params.offsetRaw))
      : 0;
  const hasMore =
    typeof params.hasMoreRaw === "boolean"
      ? params.hasMoreRaw
      : offset + params.pageCount < Math.max(total, offset + params.pageCount);
  const nextOffset =
    typeof params.nextOffsetRaw === "number" && Number.isFinite(params.nextOffsetRaw)
      ? Math.max(0, Math.floor(params.nextOffsetRaw))
      : hasMore
        ? offset + params.pageCount
        : null;
  return { total, hasMore, nextOffset };
}

export function clearCronRunsPage(state: CronState) {
  cronRunsViews.delete(state);
  state.cronRunsError = null;
  state.cronRuns = [];
  state.cronRunsTotal = 0;
  state.cronRunsHasMore = false;
  state.cronRunsNextOffset = null;
}

type CronRunsRequestIdentity = {
  client: GatewayBrowserClient;
  agentId: string | null;
  scope: CronRunScope;
  jobId: string | null;
  limit: number;
  offset: number;
  statuses: CronRunsStatusValue[];
  status: CronRunsStatusFilter;
  deliveryStatuses: CronDeliveryStatus[];
  query: string;
  sortDir: CronSortDir;
  append: boolean;
  queued?: Deferred<CronRunsLoadStatus>;
};

// The selected state owns overview, per-job, filtered, and paginated requests.
// Mutation completions refresh this view without supplying another job identity.
// Only its latest exact request may replace the history, error, or load state.
const activeCronRunsRequests = new WeakMap<CronState, CronRunsRequestIdentity>();
// Rows and failures belong to the query even after its request settles.
const cronRunsViews = new WeakMap<CronState, CronRunsRequestIdentity>();

function matchesCronRunsView(state: CronState, request: CronRunsRequestIdentity): boolean {
  return (
    state.client === request.client &&
    state.cronAgentId === request.agentId &&
    state.cronRunsScope === request.scope &&
    (request.scope !== "job" || state.cronRunsJobId === request.jobId) &&
    state.cronRunsLimit === request.limit &&
    state.cronRunsStatusFilter === request.status &&
    state.cronRunsQuery.trim() === request.query &&
    state.cronRunsSortDir === request.sortDir &&
    state.cronRunsStatuses.length === request.statuses.length &&
    state.cronRunsStatuses.every((status, index) => status === request.statuses[index]) &&
    state.cronRunsDeliveryStatuses.length === request.deliveryStatuses.length &&
    state.cronRunsDeliveryStatuses.every(
      (status, index) => status === request.deliveryStatuses[index],
    )
  );
}

function ownsCronRunsRequest(state: CronState, request: CronRunsRequestIdentity): boolean {
  return (
    activeCronRunsRequests.get(state) === request &&
    state.connected &&
    matchesCronRunsView(state, request) &&
    (!request.append ||
      Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) === request.offset)
  );
}

export async function loadCronRuns(
  state: CronState,
  opts?: { append?: boolean; coalesce?: boolean },
): Promise<CronRunsLoadStatus> {
  const client = state.client;
  if (!client || !state.connected || state.canRefresh?.() === false) {
    return "skipped";
  }
  const scope = state.cronRunsScope;
  const activeJobId = state.cronRunsJobId;
  if (scope === "job" && !activeJobId) {
    clearCronRunsPage(state);
    return "skipped";
  }
  const view = cronRunsViews.get(state);
  if (!view || !matchesCronRunsView(state, view)) {
    clearCronRunsPage(state);
  }
  const append = opts?.append === true;
  if (append && !state.cronRunsHasMore) {
    return "skipped";
  }
  const active = activeCronRunsRequests.get(state);
  if (
    opts?.coalesce &&
    !append &&
    active &&
    !active.append &&
    active.jobId === (scope === "job" ? activeJobId : null) &&
    ownsCronRunsRequest(state, active)
  ) {
    // Events invalidate one compatible read, never an explicit filter or mutation.
    return (active.queued ??= createDeferredCore<CronRunsLoadStatus>()).promise;
  }
  const request: CronRunsRequestIdentity = {
    client,
    agentId: state.cronAgentId,
    scope,
    jobId: scope === "job" ? activeJobId : null,
    limit: state.cronRunsLimit,
    offset: append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0,
    statuses: [...state.cronRunsStatuses],
    status: state.cronRunsStatusFilter,
    deliveryStatuses: [...state.cronRunsDeliveryStatuses],
    query: state.cronRunsQuery.trim(),
    sortDir: state.cronRunsSortDir,
    append,
  };
  activeCronRunsRequests.set(state, request);
  cronRunsViews.set(state, request);
  // Retained rows cannot authorize an append until their replacement page arrives.
  if (!append) {
    state.cronRunsHasMore = false;
    state.cronRunsNextOffset = null;
  }
  state.cronRunsLoadingMore = append;
  try {
    const res = await client.request<CronRunsResult>("cron.runs", {
      // An exact job owns its history; the overview's agent filter may select another owner.
      ...(request.scope === "all" && request.agentId ? { agentId: request.agentId } : {}),
      scope: request.scope,
      id: request.jobId ?? undefined,
      limit: request.limit,
      offset: request.offset,
      statuses: request.statuses.length > 0 ? request.statuses : undefined,
      status: request.status,
      deliveryStatuses: request.deliveryStatuses.length > 0 ? request.deliveryStatuses : undefined,
      query: request.query || undefined,
      sortDir: request.sortDir,
    });
    if (!ownsCronRunsRequest(state, request)) {
      return "skipped";
    }
    state.cronRunsError = null;
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.cronRuns = append ? [...state.cronRuns, ...entries] : entries;
    const meta = normalizeCronRunsPageMeta({
      totalRaw: res.total,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: entries.length,
    });
    state.cronRunsTotal = Math.max(meta.total, state.cronRuns.length);
    state.cronRunsHasMore = meta.hasMore;
    state.cronRunsNextOffset = meta.nextOffset;
    return "ok";
  } catch (err) {
    if (!ownsCronRunsRequest(state, request) || request.queued) {
      return "skipped";
    }
    state.cronRunsError = formatUiError(err);
    return "error";
  } finally {
    const reload = ownsCronRunsRequest(state, request);
    if (activeCronRunsRequests.get(state) === request) {
      activeCronRunsRequests.delete(state);
      if (append) {
        state.cronRunsLoadingMore = false;
      }
    }
    // Publish successful progress even when dirty. The tail belongs to queued
    // callers, so sustained events cannot hold the original mutation open.
    request.queued?.resolve(reload ? loadCronRuns(state, opts) : "skipped");
  }
}

export async function loadMoreCronRuns(state: CronState) {
  if (state.cronRunsScope === "job" && !state.cronRunsJobId) {
    return;
  }
  await loadCronRuns(state, { append: true });
}

export function updateCronRunsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronRunsScope"
      | "cronRunsStatuses"
      | "cronRunsDeliveryStatuses"
      | "cronRunsStatusFilter"
      | "cronRunsQuery"
      | "cronRunsSortDir"
    >
  >,
) {
  state.cronRunsScope = patch.cronRunsScope ?? state.cronRunsScope;
  if (Array.isArray(patch.cronRunsStatuses)) {
    state.cronRunsStatuses = patch.cronRunsStatuses;
    state.cronRunsStatusFilter = patch.cronRunsStatuses[0] ?? "all";
  }
  if (Array.isArray(patch.cronRunsDeliveryStatuses)) {
    state.cronRunsDeliveryStatuses = patch.cronRunsDeliveryStatuses;
  }
  if (patch.cronRunsStatusFilter) {
    state.cronRunsStatusFilter = patch.cronRunsStatusFilter;
    state.cronRunsStatuses =
      patch.cronRunsStatusFilter === "all" ? [] : [patch.cronRunsStatusFilter];
  }
  if (typeof patch.cronRunsQuery === "string") {
    state.cronRunsQuery = patch.cronRunsQuery;
  }
  state.cronRunsSortDir = patch.cronRunsSortDir ?? state.cronRunsSortDir;
}

export function retireCronRunsRequest(state: CronState) {
  activeCronRunsRequests.get(state)?.queued?.resolve("skipped");
  activeCronRunsRequests.delete(state);
}
