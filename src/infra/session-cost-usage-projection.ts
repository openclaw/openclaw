import { createTimeZoneDayKeyFormatter } from "./format-time/format-datetime.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  canUseUsageCostRollupForPartial,
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  isUsageCostRollupFresh,
} from "./session-cost-usage-rollup-codec.js";
import {
  addRollupToCostUsageSummary,
  buildSessionCostSummaryFromRollup,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
  UsageCacheStatus,
  UsageDailyBucket,
  UsageCostTranscriptFile,
} from "./session-cost-usage.types.js";

const formatUtcDayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

type UsageDayKeyFormatter = (date: Date) => string;

export type UsageCostRollupRowSource = {
  readRow: (filePath: string) => SessionCostUsageRollupRow | undefined;
  readBody: (row: SessionCostUsageRollupRow) => Uint8Array | null | Promise<Uint8Array | null>;
  onInvalidBody: (key: string) => void;
  /** Snapshot rows whose keys are absent from the resolved files. */
  remainingRows: Iterable<SessionCostUsageRollupRow>;
};

const createUsageDayKeyFormatter = (dayBucket?: UsageDailyBucket): UsageDayKeyFormatter => {
  if (dayBucket?.mode === "utc-offset") {
    return (date) =>
      formatUtcDayKey(new Date(date.getTime() + dayBucket.utcOffsetMinutes * 60 * 1000));
  }
  const timeZone =
    dayBucket?.mode === "time-zone"
      ? dayBucket.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createTimeZoneDayKeyFormatter(timeZone);
};

// Wider, open-ended ranges stay sparse instead of generating years of empty buckets.
const MAX_ZERO_FILL_DAYS = 366;

// UTC timestamps enumerate labels; usage timestamps remain in the requested calendar zone.
const parseDayKeyToUtcMs = (dayKey: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dayMs = Date.UTC(year, monthIdx, day);
  const date = new Date(dayMs);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIdx &&
    date.getUTCDate() === day
    ? dayMs
    : null;
};

// Match the request's calendar zone so the UI does not discard boundary-day usage.
const fillMissingDays = (
  dailyMap: Map<string, CostUsageTotals>,
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): void => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const startKey = formatDayKey(new Date(startMs));
  const endKey = formatDayKey(new Date(endMs));
  const startDayMs = parseDayKeyToUtcMs(startKey);
  const endDayMs = parseDayKeyToUtcMs(endKey);
  if (startDayMs === null || endDayMs === null) {
    // Preserve the endpoints if locale data produces an unexpected day-key format.
    if (!dailyMap.has(startKey)) {
      dailyMap.set(startKey, emptyTotals());
    }
    if (!dailyMap.has(endKey)) {
      dailyMap.set(endKey, emptyTotals());
    }
    return;
  }
  // Bound the fill by calendar labels, not elapsed milliseconds: DST days can
  // contain 23 or 25 hours. Wider ranges keep their sparse activity-only shape.
  const spanDays = Math.floor((endDayMs - startDayMs) / dayMs) + 1;
  if (spanDays > MAX_ZERO_FILL_DAYS) {
    return;
  }
  for (let cursorMs = startDayMs; cursorMs <= endDayMs; cursorMs += dayMs) {
    const key = formatUtcDayKey(new Date(cursorMs));
    if (!dailyMap.has(key)) {
      dailyMap.set(key, emptyTotals());
    }
  }
  if (!dailyMap.has(endKey)) {
    dailyMap.set(endKey, emptyTotals());
  }
};

const countCalendarDays = (
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): number => {
  const startDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(startMs)));
  const endDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(endMs)));
  if (startDayMs === null || endDayMs === null || endDayMs < startDayMs) {
    return Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  }
  return Math.floor((endDayMs - startDayMs) / (24 * 60 * 60 * 1000)) + 1;
};

function finishCostUsageSummary(params: {
  daily: Map<string, CostUsageTotals>;
  totals: CostUsageTotals;
  startMs: number;
  endMs: number;
  formatDay: UsageDayKeyFormatter;
  refreshing: boolean;
  cachedFiles: number;
  staleFiles: number;
  refreshedAt: number | undefined;
}): CostUsageSummary {
  fillMissingDays(params.daily, params.startMs, params.endMs, params.formatDay);
  const status = params.refreshing
    ? "refreshing"
    : params.staleFiles > 0
      ? params.cachedFiles > 0
        ? "partial"
        : "stale"
      : "fresh";
  return {
    updatedAt: Date.now(),
    days: countCalendarDays(params.startMs, params.endMs, params.formatDay),
    daily: Array.from(params.daily.entries())
      .map(([date, bucket]) => Object.assign({ date }, bucket))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    totals: params.totals,
    cacheStatus: {
      status,
      cachedFiles: params.cachedFiles,
      pendingFiles: params.staleFiles,
      staleFiles: params.staleFiles,
      refreshedAt: params.refreshedAt,
    },
  };
}

function includeRemainingRollupScans(
  rows: Iterable<SessionCostUsageRollupRow>,
  pricingFingerprint: string,
  initialLatest: number,
): number | undefined {
  let latest = initialLatest;
  for (const row of rows) {
    const entry = decodeUsageCostRollupEnvelope(row.valueJson, pricingFingerprint);
    if (entry) {
      latest = Math.max(latest, entry.scannedAt);
    }
  }
  return latest || undefined;
}

export async function projectCostUsageSummary(
  params: UsageCostRollupRowSource & {
    files: readonly UsageCostTranscriptFile[];
    pricingFingerprint: string;
    startMs: number;
    endMs: number;
    dayBucket?: UsageDailyBucket;
    refreshing: boolean;
  },
): Promise<CostUsageSummary> {
  const daily = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const formatDay = createUsageDayKeyFormatter(params.dayBucket);
  let cachedFiles = 0;
  let staleFiles = 0;
  let latestScan = 0;
  // Keep file order and per-bucket additions: folding per-file totals changes rounding.
  for (const file of params.files) {
    const row = params.readRow(file.filePath);
    const envelope = row
      ? decodeUsageCostRollupEnvelope(row.valueJson, params.pricingFingerprint)
      : undefined;
    if (envelope) {
      latestScan = Math.max(latestScan, envelope.scannedAt);
    }
    const fresh = isUsageCostRollupFresh({ checkpoint: envelope?.checkpoint, file });
    if (!fresh) {
      staleFiles += 1;
    }
    if (
      !row ||
      !envelope ||
      !canUseUsageCostRollupForPartial({ checkpoint: envelope.checkpoint, file })
    ) {
      continue;
    }
    const entry = decodeUsageCostRollup(
      row.valueJson,
      params.pricingFingerprint,
      await params.readBody(row),
    );
    if (!entry) {
      params.onInvalidBody(row.key);
      if (fresh) {
        staleFiles += 1;
      }
      continue;
    }
    cachedFiles += 1;
    addRollupToCostUsageSummary({
      rollup: entry.rollup,
      startMs: params.startMs,
      endMs: params.endMs,
      formatDay,
      daily,
      totals,
    });
  }
  return finishCostUsageSummary({
    daily,
    totals,
    startMs: params.startMs,
    endMs: params.endMs,
    formatDay,
    refreshing: params.refreshing,
    cachedFiles,
    staleFiles,
    refreshedAt: includeRemainingRollupScans(
      params.remainingRows,
      params.pricingFingerprint,
      latestScan,
    ),
  });
}

export async function projectSessionCostSummaries(
  params: UsageCostRollupRowSource & {
    sessions: ReadonlyArray<{ sessionId?: string; sessionFile: string }>;
    files: ReadonlyArray<UsageCostTranscriptFile | undefined>;
    pricingFingerprint: string;
    startMs?: number;
    endMs?: number;
    includeUntimestamped?: boolean;
    dayBucket?: UsageDailyBucket;
    refreshing: boolean;
  },
): Promise<{
  summaries: Array<SessionCostSummary | null>;
  cacheStatus: UsageCacheStatus;
  staleSessionFiles: string[];
}> {
  const summaries = Array<SessionCostSummary | null>(params.sessions.length).fill(null);
  const requestsByPath = new Map<
    string,
    Array<{
      index: number;
      session: (typeof params.sessions)[number];
      file: UsageCostTranscriptFile;
    }>
  >();
  for (const [index, session] of params.sessions.entries()) {
    const file = params.files[index];
    if (!file) {
      continue;
    }
    const requests = requestsByPath.get(file.filePath) ?? [];
    requests.push({ index, session, file });
    requestsByPath.set(file.filePath, requests);
  }
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  const includeUntimestamped =
    params.includeUntimestamped === true ||
    (params.startMs === undefined && params.endMs === undefined);
  const formatDay = createUsageDayKeyFormatter(params.dayBucket);
  let cachedFiles = 0;
  let latestScan = 0;
  for (const [filePath, requests] of requestsByPath) {
    const row = params.readRow(filePath);
    const envelope = row
      ? decodeUsageCostRollupEnvelope(row.valueJson, params.pricingFingerprint)
      : undefined;
    if (!envelope || !row) {
      continue;
    }
    latestScan = Math.max(latestScan, envelope.scannedAt);
    const usableRequests = requests.filter(({ file }) =>
      canUseUsageCostRollupForPartial({ checkpoint: envelope.checkpoint, file }),
    );
    if (usableRequests.length === 0) {
      continue;
    }
    const entry = decodeUsageCostRollup(
      row.valueJson,
      params.pricingFingerprint,
      await params.readBody(row),
    );
    if (!entry) {
      params.onInvalidBody(row.key);
      continue;
    }
    for (const { index, session, file } of usableRequests) {
      cachedFiles += 1;
      const fresh = isUsageCostRollupFresh({ checkpoint: entry.checkpoint, file });
      summaries[index] = {
        ...buildSessionCostSummaryFromRollup({
          rollup: entry.rollup,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          startMs,
          endMs,
          includeUntimestamped,
          formatDay,
        }),
        computedAt: entry.scannedAt,
        ...(!fresh ? { refreshing: params.refreshing, staleSince: file.mtimeMs } : {}),
      };
    }
  }
  const staleSessionFiles = new Set<string>();
  for (const [index, session] of params.sessions.entries()) {
    if (summaries[index] === null || summaries[index]?.staleSince !== undefined) {
      staleSessionFiles.add(params.files[index]?.sourcePath ?? session.sessionFile);
    }
  }
  return {
    summaries,
    cacheStatus: {
      status:
        staleSessionFiles.size === 0
          ? "fresh"
          : params.refreshing
            ? "refreshing"
            : cachedFiles > 0
              ? "partial"
              : "stale",
      cachedFiles,
      pendingFiles: staleSessionFiles.size,
      staleFiles: staleSessionFiles.size,
      refreshedAt: includeRemainingRollupScans(
        params.remainingRows,
        params.pricingFingerprint,
        latestScan,
      ),
    },
    staleSessionFiles: [...staleSessionFiles],
  };
}
