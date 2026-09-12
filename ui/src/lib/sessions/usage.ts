import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

export type SessionUsageTarget = { key: string; agentId?: string };

export type SessionUsageQuery = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  timeZone: "local" | "utc";
  agentId?: string;
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

export function buildSessionUsageDateParams(timeZone: "local" | "utc") {
  return timeZone === "utc"
    ? { mode: "utc" }
    : {
        mode: "specific",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
      };
}

function buildSessionUsageParams(query: SessionUsageQuery, key?: string): Record<string, unknown> {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : key ? {} : { agentScope: "all" }),
    ...buildSessionUsageDateParams(query.timeZone),
    groupBy: query.scope,
    ...(key ? { key, limit: 1 } : { limit: 1000 }),
    includeContextWeight: false,
  };
}

export function requestSessionUsage(
  client: SessionRequestClient,
  query: SessionUsageQuery,
  options?: { key?: string; includeContextWeight?: boolean; signal?: AbortSignal },
): Promise<SessionsUsageResult> {
  const params = {
    ...buildSessionUsageParams(query, options?.key),
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
