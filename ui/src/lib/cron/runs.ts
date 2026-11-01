import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronDeliveryStatus,
  CronRunScope,
  CronRunsResult,
  CronRunsStatusValue,
  CronSortDir,
} from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type { CronState } from "./types.ts";

type CronRunsLoadStatus = "ok" | "error" | "skipped";
export type CronRunsViewState = "idle" | "pending" | "failed" | "ready";

export function clearCronRunsPage(state: CronState) {
  cronRunsViews.delete(state);
  state.cronRunsError = null;
  state.cronRuns = [];
  state.cronRunsHasMore = false;
  state.cronRunsNextOffset = null;
}

type CronRunsRequestIdentity = {
  client: GatewayBrowserClient;
  agentId: string | null;
  scope: CronRunScope;
  jobId: string | null;
  runId: string | null;
  limit: number;
  offset: number;
  statuses: CronRunsStatusValue[];
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
    (state.cronRunsRunId ?? null) === request.runId &&
    (request.scope !== "job" || state.cronRunsJobId === request.jobId) &&
    state.cronRunsLimit === request.limit &&
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

export function getCronRunsViewState(state: CronState): CronRunsViewState {
  const active = activeCronRunsRequests.get(state);
  if (active && ownsCronRunsRequest(state, active)) {
    return "pending";
  }
  const view = cronRunsViews.get(state);
  if (!view || !matchesCronRunsView(state, view)) {
    return "idle";
  }
  return state.cronRunsError === null ? "ready" : "failed";
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
    runId: state.cronRunsRunId ?? null,
    limit: state.cronRunsLimit,
    offset: append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0,
    statuses: [...state.cronRunsStatuses],
    deliveryStatuses: [...state.cronRunsDeliveryStatuses],
    query: state.cronRunsQuery.trim(),
    sortDir: state.cronRunsSortDir,
    append,
  };
  activeCronRunsRequests.set(state, request);
  // Retained rows cannot authorize an append until their replacement page arrives.
  if (!append) {
    state.cronRunsHasMore = false;
    state.cronRunsNextOffset = null;
  }
  state.cronRunsLoadingMore = append;
  try {
    const res = await client.request<CronRunsResult>("cron.runs", {
      view: "summary",
      // An exact job owns its history; the overview's agent filter may select another owner.
      ...(request.scope === "all" && request.agentId ? { agentId: request.agentId } : {}),
      scope: request.scope,
      id: request.jobId ?? undefined,
      runId: request.runId ?? undefined,
      limit: request.limit,
      offset: request.offset,
      statuses: request.statuses.length > 0 ? request.statuses : undefined,
      deliveryStatuses: request.deliveryStatuses.length > 0 ? request.deliveryStatuses : undefined,
      query: request.query || undefined,
      sortDir: request.sortDir,
    });
    if (!ownsCronRunsRequest(state, request)) {
      return "skipped";
    }
    cronRunsViews.set(state, request);
    state.cronRunsError = null;
    state.cronRuns = append ? [...state.cronRuns, ...res.entries] : res.entries;
    state.cronRunsHasMore = res.hasMore;
    state.cronRunsNextOffset = res.nextOffset;
    return "ok";
  } catch (err) {
    if (!ownsCronRunsRequest(state, request) || request.queued) {
      return "skipped";
    }
    cronRunsViews.set(state, request);
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

export function loadCronRunsForJob(
  state: CronState,
  jobId: string | null,
  runId: string | null = null,
) {
  updateCronRunsFilter(state, {
    cronRunsScope: jobId === null ? "all" : "job",
    cronRunsRunId: runId,
  });
  if (runId) {
    updateCronRunsFilter(state, {
      cronRunsQuery: "",
      cronRunsStatuses: [],
      cronRunsDeliveryStatuses: [],
    });
  }
  state.cronRunsJobId = jobId;
  return loadCronRuns(state);
}

export function updateCronRunsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronRunsScope"
      | "cronRunsRunId"
      | "cronRunsStatuses"
      | "cronRunsDeliveryStatuses"
      | "cronRunsQuery"
      | "cronRunsSortDir"
    >
  >,
) {
  state.cronRunsScope = patch.cronRunsScope ?? state.cronRunsScope;
  if (patch.cronRunsRunId !== undefined) {
    state.cronRunsRunId = patch.cronRunsRunId;
  }
  if (patch.cronRunsStatuses !== undefined) {
    state.cronRunsStatuses = patch.cronRunsStatuses;
  }
  if (patch.cronRunsDeliveryStatuses !== undefined) {
    state.cronRunsDeliveryStatuses = patch.cronRunsDeliveryStatuses;
  }
  if (patch.cronRunsQuery !== undefined) {
    state.cronRunsQuery = patch.cronRunsQuery;
  }
  state.cronRunsSortDir = patch.cronRunsSortDir ?? state.cronRunsSortDir;
}

export function retireCronRunsRequest(state: CronState) {
  activeCronRunsRequests.get(state)?.queued?.resolve("skipped");
  activeCronRunsRequests.delete(state);
}
