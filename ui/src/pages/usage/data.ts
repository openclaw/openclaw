import type {
  SessionsUsageResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
} from "../../api/types.ts";
import {
  buildSessionUsageDateParams,
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
} from "../../lib/sessions/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../ui/controllers/scope-errors.ts";
import type { GatewayBrowserClient } from "../../ui/gateway.ts";
import type { SessionLogEntry } from "./view.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageScope: "instance" | "family";
  usageAgentId: string | null;
  usageQuery: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageTimeZone: "local" | "utc";
};

function toErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error && typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err) || "request failed";
    } catch {
      // ignore
    }
  }
  return "request failed";
}

function applyUsageResults(state: UsageState, sessionsRes: unknown, costRes: unknown) {
  if (sessionsRes) {
    state.usageResult = sessionsRes as SessionsUsageResult;
  }
  if (costRes) {
    state.usageCostSummary = costRes as CostUsageSummary;
  }
}

export async function loadUsage(
  state: UsageState,
  overrides?: {
    startDate?: string;
    endDate?: string;
  },
) {
  // Capture client for TS18047 work around on it being possibly null
  const client = state.client;
  if (!client || !state.connected || state.usageLoading) {
    return;
  }
  state.usageLoading = true;
  state.usageError = null;
  try {
    const startDate = overrides?.startDate ?? state.usageStartDate;
    const endDate = overrides?.endDate ?? state.usageEndDate;
    const agentId = normalizeLowercaseStringOrEmpty(state.usageAgentId ?? "") || undefined;
    const sessionUsage = requestSessionUsage(client, {
      startDate,
      endDate,
      agentId,
      scope: state.usageScope,
      timeZone: state.usageTimeZone,
    });
    const agentScopeParams = agentId ? { agentId } : { agentScope: "all" as const };
    const [sessionsRes, costRes] = await Promise.all([
      sessionUsage,
      client.request("usage.cost", {
        startDate,
        endDate,
        ...agentScopeParams,
        ...buildSessionUsageDateParams(state.usageTimeZone),
      }),
    ]);
    applyUsageResults(state, sessionsRes, costRes);
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.usageResult = null;
      state.usageCostSummary = null;
      state.usageError = formatMissingOperatorReadScopeMessage("usage");
    } else {
      state.usageError = toErrorMessage(err);
    }
  } finally {
    state.usageLoading = false;
  }
}

async function runOptionalUsageDetailRequest(
  state: UsageState,
  loadingKey: "usageTimeSeriesLoading" | "usageSessionLogsLoading",
  run: (client: GatewayBrowserClient) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state[loadingKey]) {
    return;
  }
  state[loadingKey] = true;
  try {
    await run(client);
  } catch {
    // Silently fail - optional detail endpoints
  } finally {
    state[loadingKey] = false;
  }
}

export async function loadSessionTimeSeries(state: UsageState, sessionKey: string) {
  await runOptionalUsageDetailRequest(state, "usageTimeSeriesLoading", async (client) => {
    state.usageTimeSeries = await requestSessionUsageTimeSeries(client, sessionKey);
  });
}

export async function loadSessionLogs(state: UsageState, sessionKey: string) {
  await runOptionalUsageDetailRequest(state, "usageSessionLogsLoading", async (client) => {
    state.usageSessionLogs = null;
    const payload = await requestSessionUsageLogs(client, sessionKey);
    const logs = payload?.logs;
    state.usageSessionLogs = Array.isArray(logs) ? (logs as SessionLogEntry[]) : null;
  });
}
