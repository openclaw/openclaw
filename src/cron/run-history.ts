/** Cron run-history reads backed by authoritative cron-owned history rows. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  compareCronRunRecordsNewestFirst,
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  isCronDeliveryStatus,
  isCronRunStatus,
} from "./run-history-detail.js";
import { cronRunEntryMatchesLink } from "./run-link.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronRunRecord } from "./store/run-history.types.js";
import type { CronDeliveryStatus, CronRunStatus } from "./types.js";

type CronRunHistorySortDir = "asc" | "desc";
type CronRunHistoryStatusFilter = "all" | CronRunStatus;

export type ReadCronRunHistoryPageOptions = {
  storeKey: string;
  limit?: number;
  offset?: number;
  jobId?: string;
  agentId?: string;
  runId?: string;
  status?: CronRunHistoryStatusFilter;
  statuses?: CronRunStatus[];
  deliveryStatus?: CronDeliveryStatus;
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: CronRunHistorySortDir;
  jobNameById?: Record<string, string>;
  /** Filter before paging so hidden runs cannot consume page slots or inflate totals. */
  entryFilter?: (entry: CronRunLogEntry) => boolean;
};

type CronRunHistoryPage = {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

const INVALID_CRON_RUN_JOB_ID_MESSAGE = "invalid cron run job id";

export function normalizeCronRunJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_RUN_JOB_ID_MESSAGE);
  }
  return trimmed;
}

export function isInvalidCronRunJobIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_RUN_JOB_ID_MESSAGE;
}

function normalizeStatusFilter<T>(
  values: T[] | undefined,
  fallback: unknown,
  predicate: (value: unknown) => value is T,
): T[] | null {
  if (values?.length) {
    const validValues = values.filter(predicate);
    if (validValues.length > 0) {
      return uniqueValues(validValues);
    }
  }
  return predicate(fallback) ? [fallback] : null;
}

function queryText(entry: CronRunLogEntry, jobNameById?: Record<string, string>): string {
  return [
    entry.summary ?? "",
    entry.error ?? "",
    entry.errorReason ?? "",
    entry.diagnostics?.summary ?? "",
    ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
    entry.jobId,
    jobNameById?.[entry.jobId] ?? "",
    entry.delivery?.intended?.channel ?? "",
    entry.delivery?.resolved?.channel ?? "",
    ...(entry.delivery?.messageToolSentTo ?? []).map((target) => target.channel),
  ].join(" ");
}

function attachJobNames(entries: CronRunLogEntry[], jobNameById?: Record<string, string>): void {
  for (const entry of entries) {
    const jobName = jobNameById?.[entry.jobId];
    if (jobName) {
      entry.jobName = jobName;
    }
  }
}

export function projectCronRunHistoryPage(
  records: readonly CronRunRecord[],
  options: ReadCronRunHistoryPageOptions,
): CronRunHistoryPage {
  const jobId = options.jobId ? normalizeCronRunJobId(options.jobId) : undefined;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const statuses = normalizeStatusFilter(options.statuses, options.status, isCronRunStatus);
  const deliveryStatuses = normalizeStatusFilter(
    options.deliveryStatuses,
    options.deliveryStatus,
    isCronDeliveryStatus,
  );
  const runId = normalizeOptionalString(options.runId);
  const agentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
  const query = normalizeLowercaseStringOrEmpty(options.query);
  const sortMultiplier = options.sortDir === "asc" ? -1 : 1;
  let rows = records
    .filter(
      (record) =>
        (!jobId || record.jobId === jobId) && cronRunRecordStoreKey(record) === options.storeKey,
    )
    .filter((record) => !agentId || record.agentId === agentId)
    .map((record) => ({ record, entry: cronRunRecordToRunLogEntry(record) }))
    .filter((row): row is { record: CronRunRecord; entry: CronRunLogEntry } => row.entry !== null);
  if (runId) {
    const exact = rows.filter(({ entry }) => entry.runId === runId);
    const aliases = exact.length
      ? []
      : rows.filter(({ entry }) => cronRunEntryMatchesLink(runId, entry));
    // Public ids retain precedence; a reused session or start time cannot select another run.
    rows = exact.length ? exact : aliases.length === 1 ? aliases : [];
  }
  rows = rows
    .filter(({ entry }) => {
      if (statuses && (!entry.status || !statuses.includes(entry.status))) {
        return false;
      }
      if (deliveryStatuses && !deliveryStatuses.includes(entry.deliveryStatus ?? "not-requested")) {
        return false;
      }
      return (
        (!query ||
          normalizeLowercaseStringOrEmpty(queryText(entry, options.jobNameById)).includes(query)) &&
        (!options.entryFilter || options.entryFilter(entry))
      );
    })
    .toSorted(
      (left, right) => sortMultiplier * compareCronRunRecordsNewestFirst(left.record, right.record),
    );
  const total = rows.length;
  const boundedOffset = Math.min(total, offset);
  const entries = rows.slice(boundedOffset, boundedOffset + limit).map(({ entry }) => entry);
  attachJobNames(entries, options.jobNameById);
  const nextOffset = boundedOffset + entries.length;
  return {
    entries,
    total,
    offset: boundedOffset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
