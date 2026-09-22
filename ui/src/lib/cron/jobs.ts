import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { getCronJobPayload } from "./payload.ts";
import type { CronJobsState } from "./types.ts";

function hasCronJobPayload(job: CronJob): boolean {
  return getCronJobPayload(job) !== null;
}

function readCanonicalCronJobsPage<Row>(
  value: CronJobsListResult<Row>,
  requestedLimit: number,
): CronJobsListResult<Row> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    typeof value.snapshotRevision !== "string" ||
    value.snapshotRevision.length === 0 ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > requestedLimit ||
    value.jobs.length > value.limit ||
    typeof value.hasMore !== "boolean" ||
    (value.nextOffset !== null &&
      (typeof value.nextOffset !== "number" ||
        !Number.isSafeInteger(value.nextOffset) ||
        value.nextOffset < 0))
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  return value;
}

function assertCanonicalCronJobsCursor(page: CronJobsListResult<unknown>, requestedOffset: number) {
  const nextOffset = requestedOffset + page.jobs.length;
  if (
    page.offset !== requestedOffset ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset > page.total ||
    (page.hasMore
      ? page.nextOffset !== nextOffset || nextOffset <= requestedOffset || nextOffset >= page.total
      : page.nextOffset !== null || nextOffset !== page.total)
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
}

function queueCronJobsSnapshotRecovery<Row>(state: CronJobsState<Row>, tableFilters: boolean) {
  if (state.cronJobsReloadPending) {
    return;
  }
  state.cronJobsReloadPending = true;
  state.cronJobsReloadPendingTableFilters = tableFilters;
}

async function drainPendingCronJobsReload<Row>(
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

type CronJobsPageOptions = { append?: boolean; tableFilters?: boolean };
type CronJobsProjection<Row> = {
  compact?: true;
  readRows: (rows: Row[]) => Row[];
};

const fullCronJobsProjection: CronJobsProjection<CronJob> = {
  readRows: (rows) => rows.filter(hasCronJobPayload),
};

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
};

export function loadCronJobsPage(state: CronJobsState, opts?: CronJobsPageOptions) {
  return loadCronJobsProjectionPage(state, fullCronJobsProjection, opts);
}

export function loadCompactCronJobsPage(
  state: CronJobsState<CronCompactJob>,
  opts?: CronJobsPageOptions,
) {
  return loadCronJobsProjectionPage(state, compactCronJobsProjection, opts);
}

async function loadCronJobsProjectionPage<Row>(
  state: CronJobsState<Row>,
  projection: CronJobsProjection<Row>,
  opts?: CronJobsPageOptions,
) {
  if (!state.client || !state.connected || state.canRefresh?.() === false) {
    return;
  }
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
  if (append) {
    state.cronJobsLoadingMore = true;
  } else {
    state.cronLoading = true;
  }
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
    const page = readCanonicalCronJobsPage<Row>(res, state.cronJobsLimit);
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
    assertCanonicalCronJobsCursor(page, offset);
    const jobs = projection.readRows(page.jobs);
    const nextJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    state.cronJobs = nextJobs;
    state.cronJobsSnapshotRevision = page.snapshotRevision;
    state.cronJobsTotal = page.total;
    state.cronJobsHasMore = page.hasMore;
    state.cronJobsNextOffset = page.nextOffset;
    // A filtered/paged list is not deletion authority. Only an explicit remove
    // may clear an editor opened from an exact job definition.
  } catch (err) {
    state.cronJobsError = formatUiError(err);
  } finally {
    if (append) {
      state.cronJobsLoadingMore = false;
    } else {
      state.cronLoading = false;
    }
    await drainPendingCronJobsReload(state, projection);
  }
}
