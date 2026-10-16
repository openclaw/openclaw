import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import type { SessionRequestClient } from "./session-capability.ts";

export type SessionUsageTarget = { key: string; agentId?: string };

export type SessionUsageQuery = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  timeZone: "local" | "utc";
  agentId?: string;
  creatorKey?: string;
  query?: string;
  selectedDays?: string[];
  selectedHours?: number[];
  selectedSessions?: string[];
  recentKeys?: string[];
  offset?: number;
  sort?: "recent" | "tokens" | "cost" | "messages" | "errors";
  sortDirection?: "asc" | "desc";
};

function formatUtcOffset(timezoneOffsetMinutes: number): string {
  const offsetFromUtcMinutes = -timezoneOffsetMinutes;
  const sign = offsetFromUtcMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetFromUtcMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
}

function buildSessionUsageDateParams(timeZone: "local" | "utc") {
  return timeZone === "utc"
    ? { mode: "utc" }
    : {
        mode: "specific",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
      };
}

export function requestSessionUsage(
  client: SessionRequestClient,
  query: SessionUsageQuery,
  options?: {
    key?: string;
    projection?: "overview";
    limit?: number;
    includeContextWeight?: boolean;
    signal?: AbortSignal;
  },
): Promise<SessionsUsageResult> {
  const key = options?.key;
  const params = {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : key ? {} : { agentScope: "all" }),
    ...buildSessionUsageDateParams(query.timeZone),
    ...(query.creatorKey ? { creatorKey: query.creatorKey } : {}),
    groupBy: query.scope,
    ...(key
      ? { key, limit: 1 }
      : {
          limit: options?.limit ?? (options?.projection === "overview" ? 50 : 1000),
          ...(options?.projection ? { projection: options.projection } : {}),
          ...(query.query ? { query: query.query } : {}),
          ...(query.selectedDays?.length ? { selectedDays: query.selectedDays } : {}),
          ...(query.selectedHours?.length ? { selectedHours: query.selectedHours } : {}),
          ...(query.selectedSessions?.length ? { selectedSessions: query.selectedSessions } : {}),
          ...(query.offset ? { offset: query.offset } : {}),
          ...(query.recentKeys ? { recentKeys: query.recentKeys } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.sortDirection ? { sortDirection: query.sortDirection } : {}),
        }),
    includeContextWeight: options?.includeContextWeight === true,
  };
  return options?.signal
    ? client.request<SessionsUsageResult>("sessions.usage", params, { signal: options.signal })
    : client.request<SessionsUsageResult>("sessions.usage", params);
}

export function requestSessionUsageTimeSeries(
  client: SessionRequestClient,
  target: SessionUsageTarget,
): Promise<SessionUsageTimeSeries | null> {
  return client
    .request<SessionUsageTimeSeries | undefined>("sessions.usage.timeseries", target)
    .then((result) => result ?? null);
}

export function requestSessionUsageLogs(
  client: SessionRequestClient,
  target: SessionUsageTarget,
): Promise<{ logs?: unknown }> {
  return client.request<{ logs?: unknown }>("sessions.usage.logs", {
    ...target,
    limit: 1000,
  });
}
