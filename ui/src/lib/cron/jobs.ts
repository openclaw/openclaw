import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { CronListParams } from "../../../../packages/gateway-protocol/src/schema/cron.types.ts";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../../../src/cron/service/list-page-validation.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  readCronRuntimeEvent,
  usesCronInventoryEvents,
  type Runtime,
} from "./inventory-connection.ts";
import { cronInventoryHasJob, readCronInventory } from "./inventory.ts";
import { buildCronJobsListParams } from "./list-params.ts";
import { applyCompactCronRuntime } from "./runtime-projection.ts";
import type { CronJobsState } from "./types.ts";

function clearCronJobsSnapshot(state: CronJobsState<unknown>) {
  state.cronJobs = [];
  state.cronJobsSnapshotRevision = null;
  state.cronJobsTotal = 0;
  state.cronJobsHasMore = false;
  state.cronJobsNextOffset = null;
}

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

export type CronJobsPageOptions = {
  append?: boolean;
  tableFilters?: boolean;
  event?: unknown;
  refresh?: boolean;
};
export type CronJobsProjection<Row extends CronInventoryJob> = {
  compact?: true;
  read: (
    client: GatewayBrowserClient,
    params: Omit<CronListParams, "compact">,
    options: { refresh?: boolean; canRead?: () => boolean },
  ) => Promise<CronJobsListResult<Row>>;
  applyRuntime: (
    state: CronJobsState<Row>,
    index: number,
    event: Omit<Runtime, "revision">,
  ) => boolean;
};

const cronInventoryScopes = new WeakMap<
  CronJobsState<unknown>,
  {
    scope: CronJobsState["cronAgentId" | "cronSessionFilter"];
    query?: string;
    requestedQuery: string;
  }
>();
const cronInventoryRequests = new WeakMap<CronJobsState<unknown>, object>();

export function retireCronJobsRequest(state: CronJobsState<unknown>) {
  cronInventoryRequests.delete(state);
  state.cronLoading = false;
  state.cronJobsLoadingMore = false;
}

const compactCronJobsProjection: CronJobsProjection<CronCompactJob> = {
  compact: true,
  read: (client, params, options) =>
    readCronInventory(client, { ...params, compact: true }, options),
  applyRuntime: (state, index, event) => {
    if (state.cronJobsSortBy !== "name") {
      return false;
    }
    state.cronJobs = state.cronJobs.with(
      index,
      applyCompactCronRuntime(state.cronJobs[index]!, event),
    );
    return true;
  },
};

function applyLegacyCronJobsEvent<Row extends CronInventoryJob>(
  state: CronJobsState<Row>,
  projection: CronJobsProjection<Row>,
  payload: unknown,
): boolean {
  const event = readCronRuntimeEvent(payload);
  if (
    !event ||
    state.cronLoading ||
    state.cronJobsLoadingMore ||
    state.cronJobsReloadPending ||
    !state.cronJobsSnapshotRevision ||
    state.cronJobsError ||
    state.cronJobsHasMore ||
    state.cronJobs.length !== state.cronJobsTotal ||
    !(cronInventoryScopes.get(state)?.scope === (state.cronSessionFilter ?? state.cronAgentId)) ||
    state.cronJobsLastStatusFilter !== "all"
  ) {
    return false;
  }
  // Definitions, unknown membership, filtered status and incomplete windows need a list read.
  const index = state.cronJobs.findIndex((job) => job.id === event.jobId);
  const previous = state.cronJobs[index];
  if (
    !previous ||
    previous.name !== event.job.name ||
    previous.agentId !== event.job.agentId ||
    previous.enabled !== event.job.enabled
  ) {
    return false;
  }
  if (event.job.updatedAtMs < previous.updatedAtMs) {
    return true;
  }
  return projection.applyRuntime(state, index, event);
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
  const append = opts?.append === true;
  const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
  const params = buildCronJobsListParams(state, { offset, tableFilters: opts?.tableFilters });
  if (opts?.event) {
    if (usesCronInventoryEvents(state.client)) {
      if (
        !cronInventoryHasJob(state.client, { ...params, compact: projection.compact }, opts.event)
      ) {
        return;
      }
    } else if (applyLegacyCronJobsEvent(state, projection, opts.event)) {
      return;
    }
  }
  const scope = state.cronSessionFilter ?? state.cronAgentId;
  const previous = cronInventoryScopes.get(state);
  const query = JSON.stringify([projection.compact === true, { ...params, offset: 0 }]);
  if (
    !append &&
    usesCronInventoryEvents(state.client) &&
    previous?.scope === scope &&
    previous?.query === query
  ) {
    // Runtime reprojection and same-query refreshes retain the expanded window.
    params.limit = Math.max(state.cronJobsLimit, state.cronJobs.length);
  }
  const request = {};
  const isCurrentScope = () =>
    cronInventoryRequests.get(state) === request &&
    (state.cronSessionFilter ?? state.cronAgentId) === scope;
  // An editor can survive scope hydration; its inventory cannot. Retire both
  // retained rows and late responses before a failed replacement can expose them.
  if (previous && previous.scope !== scope) {
    clearCronJobsSnapshot(state);
  }
  cronInventoryScopes.set(state, {
    scope,
    query: previous?.scope === scope ? previous.query : undefined,
    requestedQuery: query,
  });
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
  state.cronJobsReadDenied = false;
  try {
    const res = await projection.read(state.client, params, {
      refresh: opts?.refresh,
      canRead: state.canRefresh,
    });
    // A queued filter owns the next page. Keep the accepted rows until it arrives.
    if (!isCurrentScope() || cronInventoryScopes.get(state)?.requestedQuery !== query) {
      return;
    }
    const page = readCanonicalCronListPage<Row>(res, params.limit ?? state.cronJobsLimit);
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
    cronInventoryScopes.set(state, { scope, query, requestedQuery: query });
    state.cronJobs = append ? [...state.cronJobs, ...page.jobs] : page.jobs;
    state.cronJobsSnapshotRevision = page.snapshotRevision;
    state.cronJobsTotal = page.total;
    state.cronJobsHasMore = page.hasMore;
    state.cronJobsNextOffset = page.nextOffset;
    // A filtered/paged list is not deletion authority. Only an explicit remove
    // may clear an editor opened from an exact job definition.
  } catch (err) {
    if (isCurrentScope()) {
      state.cronJobsError = formatUiError(err);
      state.cronJobsReadDenied =
        err instanceof GatewayProtocolRequestError && err.gatewayCode === "FORBIDDEN";
      if (state.cronJobsReadDenied) {
        clearCronJobsSnapshot(state);
        // A queued invalidation cannot extend a read that was authoritatively refused.
        state.cronJobsReloadPending = false;
        state.cronJobsReloadPendingTableFilters = false;
      }
    }
  } finally {
    if (cronInventoryRequests.get(state) === request) {
      cronInventoryRequests.delete(state);
      state[loadingKey] = false;
      await drainPendingCronJobsReload(state, projection);
    }
  }
}
