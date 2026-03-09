import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsUsageResult, CostUsageSummary, SessionUsageTimeSeries } from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageTimeZone: "local" | "utc";
  settings?: { gatewayUrl?: string };
};

type DateInterpretationMode = "utc" | "gateway" | "specific";

type UsageDateInterpretationParams = {
  mode: DateInterpretationMode;
  utcOffset?: string;
};

const LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY = "openclaw.control.usage.date-params.v1";
const LEGACY_USAGE_DATE_PARAMS_DEFAULT_GATEWAY_KEY = "__default__";
const LEGACY_USAGE_DATE_PARAMS_MODE_RE = /unexpected property ['"]mode['"]/i;
const LEGACY_USAGE_DATE_PARAMS_OFFSET_RE = /unexpected property ['"]utcoffset['"]/i;
const LEGACY_USAGE_DATE_PARAMS_INVALID_RE = /invalid sessions\.usage params/i;

let legacyUsageDateParamsCache: Set<string> | null = null;

function getLocalStorage(): Storage | null {
  // Support browser runtime and node tests (when localStorage is stubbed globally).
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

function loadLegacyUsageDateParamsCache(): Set<string> {
  const storage = getLocalStorage();
  if (!storage) {
    return new Set<string>();
  }
  try {
    const raw = storage.getItem(LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw) as { unsupportedGatewayKeys?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.unsupportedGatewayKeys)) {
      return new Set<string>();
    }
    return new Set(
      parsed.unsupportedGatewayKeys
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}

function persistLegacyUsageDateParamsCache(cache: Set<string>) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY,
      JSON.stringify({ unsupportedGatewayKeys: Array.from(cache) }),
    );
  } catch {
    // ignore quota/private-mode failures
  }
}

function getLegacyUsageDateParamsCache(): Set<string> {
  if (!legacyUsageDateParamsCache) {
    legacyUsageDateParamsCache = loadLegacyUsageDateParamsCache();
  }
  return legacyUsageDateParamsCache;
}

function normalizeGatewayCompatibilityKey(gatewayUrl?: string): string {
  const trimmed = gatewayUrl?.trim();
  if (!trimmed) {
    return LEGACY_USAGE_DATE_PARAMS_DEFAULT_GATEWAY_KEY;
  }
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function resolveGatewayCompatibilityKey(state: UsageState): string {
  return normalizeGatewayCompatibilityKey(state.settings?.gatewayUrl);
}

function shouldSendLegacyDateInterpretation(state: UsageState): boolean {
  return !getLegacyUsageDateParamsCache().has(resolveGatewayCompatibilityKey(state));
}

function rememberLegacyDateInterpretation(state: UsageState) {
  const cache = getLegacyUsageDateParamsCache();
  cache.add(resolveGatewayCompatibilityKey(state));
  persistLegacyUsageDateParamsCache(cache);
}

function isLegacyDateInterpretationUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    (LEGACY_USAGE_DATE_PARAMS_MODE_RE.test(message) ||
      LEGACY_USAGE_DATE_PARAMS_OFFSET_RE.test(message))
  );
}

const formatUtcOffset = (timezoneOffsetMinutes: number): string => {
  // `Date#getTimezoneOffset()` is minutes to add to local time to reach UTC.
  // Convert to UTC±H[:MM] where positive means east of UTC.
  const offsetFromUtcMinutes = -timezoneOffsetMinutes;
  const sign = offsetFromUtcMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetFromUtcMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`;
};

const buildDateInterpretationParams = (
  timeZone: "local" | "utc",
  includeDateInterpretation: boolean,
): UsageDateInterpretationParams | undefined => {
  if (!includeDateInterpretation) {
    return undefined;
  }
  if (timeZone === "utc") {
    return { mode: "utc" };
  }
  return {
    mode: "specific",
    utcOffset: formatUtcOffset(new Date().getTimezoneOffset()),
  };
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
      const serialized = JSON.stringify(err);
      if (serialized) {
        return serialized;
      }
    } catch {
      // ignore
    }
  }
  return "request failed";
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
  if (!client || !state.connected) {
    return;
  }
  if (state.usageLoading) {
    return;
  }
  state.usageLoading = true;
  state.usageError = null;
  try {
    const startDate = overrides?.startDate ?? state.usageStartDate;
    const endDate = overrides?.endDate ?? state.usageEndDate;
    const runUsageRequests = async (includeDateInterpretation: boolean) => {
      const dateInterpretation = buildDateInterpretationParams(
        state.usageTimeZone,
        includeDateInterpretation,
      );
      return await Promise.all([
        client.request("sessions.usage", {
          startDate,
          endDate,
          ...dateInterpretation,
          limit: 1000, // Cap at 1000 sessions
          includeContextWeight: true,
        }),
        client.request("usage.cost", {
          startDate,
          endDate,
          ...dateInterpretation,
        }),
      ]);
    };

    const applyUsageResults = (sessionsRes: unknown, costRes: unknown) => {
      if (sessionsRes) {
        state.usageResult = sessionsRes as SessionsUsageResult;
      }
      if (costRes) {
        state.usageCostSummary = costRes as CostUsageSummary;
      }
    };

    const includeDateInterpretation = shouldSendLegacyDateInterpretation(state);
    try {
      const [sessionsRes, costRes] = await runUsageRequests(includeDateInterpretation);
      applyUsageResults(sessionsRes, costRes);
    } catch (err) {
      if (includeDateInterpretation && isLegacyDateInterpretationUnsupportedError(err)) {
        // Older gateways reject `mode`/`utcOffset` in `sessions.usage`.
        // Remember this per gateway and retry once without those fields.
        rememberLegacyDateInterpretation(state);
        const [sessionsRes, costRes] = await runUsageRequests(false);
        applyUsageResults(sessionsRes, costRes);
      } else {
        throw err;
      }
    }
  } catch (err) {
    state.usageError = toErrorMessage(err);
  } finally {
    state.usageLoading = false;
  }
}

export const __test = {
  formatUtcOffset,
  buildDateInterpretationParams,
  toErrorMessage,
  isLegacyDateInterpretationUnsupportedError,
  normalizeGatewayCompatibilityKey,
  shouldSendLegacyDateInterpretation,
  rememberLegacyDateInterpretation,
  resetLegacyUsageDateParamsCache: () => {
    legacyUsageDateParamsCache = null;
  },
};

export async function loadSessionTimeSeries(state: UsageState, sessionKey: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.usageTimeSeriesLoading) {
    return;
  }
  state.usageTimeSeriesLoading = true;
  state.usageTimeSeries = null;
  try {
    const res = await state.client.request("sessions.usage.timeseries", { key: sessionKey });
    if (res) {
      state.usageTimeSeries = res as SessionUsageTimeSeries;
    }
  } catch {
    // Silently fail - time series is optional
    state.usageTimeSeries = null;
  } finally {
    state.usageTimeSeriesLoading = false;
  }
}

export async function loadSessionLogs(state: UsageState, sessionKey: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.usageSessionLogsLoading) {
    return;
  }
  state.usageSessionLogsLoading = true;
  state.usageSessionLogs = null;
  try {
    const res = await state.client.request("sessions.usage.logs", {
      key: sessionKey,
      limit: 1000,
    });
    if (res && Array.isArray((res as { logs: SessionLogEntry[] }).logs)) {
      state.usageSessionLogs = (res as { logs: SessionLogEntry[] }).logs;
    }
  } catch {
    // Silently fail - logs are optional
    state.usageSessionLogs = null;
  } finally {
    state.usageSessionLogsLoading = false;
  }
}
