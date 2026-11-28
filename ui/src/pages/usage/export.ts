/// <reference lib="es2024.object" />

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionLatencyStats } from "../../../../src/infra/session-cost-usage.types.js";
import {
  usageDailyModelIdentity,
  usageModelIdentity,
} from "../../../../src/shared/usage-aggregates.js";
import { compactUsageOverviewSession } from "../../../../src/shared/usage-overview.js";
import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";
import { showToast } from "../../lib/toast.ts";
import { isUsageCacheIncomplete } from "./cache-status.ts";
import type { SessionsUsageResult } from "./data-types.ts";
import { formatIsoDate } from "./helpers.ts";
import { buildDailyCsv, buildSessionsCsv } from "./query.ts";
import type { UsageJsonExport, UsageSessionEntry } from "./usage-state-types.ts";

registerUsageEnglish();

function sessionIdentity(row: UsageSessionEntry) {
  return JSON.stringify([row.agentId, row.key, row.sessionId, row.includedSessionIds?.toSorted()]);
}

// Cohort and row accumulation can differ by roundoff. Counts and all other discrete facts are exact.
function sameReportValue(a: unknown, b: unknown, relativeError: number): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === "number" && typeof b === "number") {
    return (
      !(Number.isInteger(a) && Number.isInteger(b)) &&
      Math.abs(a - b) <= relativeError * Math.max(Math.abs(a), Math.abs(b))
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((value, i) => sameReportValue(value, b[i], relativeError))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    // Optional fields may be omitted on the wire.
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!sameReportValue(a[key], b[key], relativeError)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function groupByIdentity<T>(rows: readonly T[] | undefined, identity: (row: T) => string) {
  if (!rows) {
    return undefined;
  }
  return Object.groupBy(rows, identity);
}

// The overview takes the largest quarter p95. Detail ranks the combined samples.
function comparableLatency<T extends SessionLatencyStats>(latency: T | undefined) {
  if (!latency) {
    return undefined;
  }
  const { p95Ms: _p95Ms, ...common } = latency;
  return common;
}

function comparableAggregates(aggregates: SessionsUsageResult["aggregates"]) {
  // These groups are ranked by measurements. Roundoff can change their display order.
  return {
    ...aggregates,
    latency: comparableLatency(aggregates.latency),
    dailyLatency: aggregates.dailyLatency?.map(comparableLatency),
    tools: {
      ...aggregates.tools,
      tools: groupByIdentity(aggregates.tools.tools, (row) => row.name),
    },
    byModel: groupByIdentity(aggregates.byModel, (row) =>
      usageModelIdentity(row.provider, row.model),
    ),
    byProvider: groupByIdentity(aggregates.byProvider, (row) => row.provider ?? "unknown"),
    byAgent: groupByIdentity(aggregates.byAgent, (row) => row.agentId),
    byChannel: groupByIdentity(aggregates.byChannel, (row) => row.channel),
    byCreator: groupByIdentity(aggregates.byCreator, (row) => row.key),
    modelDaily: groupByIdentity(aggregates.modelDaily, (row) =>
      usageDailyModelIdentity(row.date, row.provider, row.model),
    ),
  };
}

function measuredUsage(row: UsageSessionEntry, days: ReadonlySet<string>) {
  const { usage } = compactUsageOverviewSession(row, days);
  // Recomputing cache metadata for a new prompt report does not change the measured usage.
  return usage
    ? {
        ...usage,
        latency: comparableLatency(usage.latency),
        computedAt: undefined,
        refreshing: undefined,
        staleSince: undefined,
      }
    : null;
}

function matchesDisplayedSnapshot(
  displayed: SessionsUsageResult,
  data: UsageJsonExport,
  query: SessionUsageQuery,
) {
  const rows = query.selectedSessions?.length
    ? (displayed.overview?.selectedRows ??
      displayed.sessions.filter((row) => query.selectedSessions?.includes(row.key)))
    : displayed.sessions;
  const exported = new Map(data.sessions.map((row) => [sessionIdentity(row), row]));
  const days = new Set(query.selectedDays);
  const relativeError = Number.EPSILON * Math.max(1, data.sessions.length, days.size);
  return (
    (displayed.overview?.selectedRowCount ?? data.sessions.length) === data.sessions.length &&
    sameReportValue(displayed.totals, data.totals, relativeError) &&
    sameReportValue(
      comparableAggregates(displayed.aggregates),
      comparableAggregates(data.aggregates),
      relativeError,
    ) &&
    rows.every((row) => {
      const detail = exported.get(sessionIdentity(row));
      return (
        detail !== undefined &&
        sameReportValue(measuredUsage(row, days), measuredUsage(detail, days), relativeError)
      );
    })
  );
}

export function createUsageExportRequest(
  notify: () => void,
  gateway: GatewayPageBinding,
  query: () => SessionUsageQuery,
  displayedSnapshot?: () => SessionsUsageResult | null,
) {
  return createPageRequest(notify, {
    task: async (format: "json" | "sessions-csv" | "daily-csv", { signal }) => {
      const connection = gateway.capture();
      if (!connection) {
        throw new Error(t("common.offline"));
      }
      const selectedQuery = query();
      const displayed = format === "json" ? displayedSnapshot?.() : undefined;
      const result = await requestSessionUsage(
        connection.client,
        { ...selectedQuery, offset: undefined },
        {
          includeContextWeight: format === "json",
          ...(format === "daily-csv"
            ? { projection: "overview" as const, limit: 50 }
            : { limit: Number.MAX_SAFE_INTEGER }),
          signal,
        },
      );
      if (
        isUsageCacheIncomplete(result.cacheStatus, undefined) &&
        result.overview?.selectedUsageComplete !== true
      ) {
        throw new Error(t("usage.export.incomplete"));
      }
      const selectedKeys = new Set(selectedQuery.selectedSessions);
      const data: UsageJsonExport = {
        sessions: selectedKeys.size
          ? result.sessions.filter((session) => selectedKeys.has(session.key))
          : result.sessions,
        totals: result.totals,
        aggregates: result.aggregates,
        daily: result.aggregates.costDaily ?? [],
      };
      if (
        displayed === null ||
        (displayed && !matchesDisplayedSnapshot(displayed, data, selectedQuery))
      ) {
        throw new Error(t("usage.export.changed"));
      }
      return { connection, data, format };
    },
    onComplete: ({ connection, data, format }) => {
      if (!gateway.isCurrent(connection)) {
        return;
      }
      const stamp = formatIsoDate(new Date());
      if (format === "json") {
        downloadTextFile(
          `openclaw-usage-${stamp}.json`,
          JSON.stringify(data, null, 2),
          "application/json;charset=utf-8",
        );
      } else {
        const kind = format === "sessions-csv" ? "sessions" : "daily";
        downloadTextFile(
          `openclaw-usage-${kind}-${stamp}.csv`,
          kind === "sessions" ? buildSessionsCsv(data.sessions) : buildDailyCsv(data.daily),
          "text/csv;charset=utf-8",
        );
      }
    },
    onError: (error) => {
      showToast({
        severity: "error",
        message: `${t("usage.export.label")}: ${formatUiError(error, "request failed")}`,
      });
    },
  });
}
