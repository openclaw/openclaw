import { getSafeLocalStorage } from "../../local-storage.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsUsageResult, CostUsageSummary, SessionUsageTimeSeries } from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageRequestVersion: number;
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
  usageTimeSeriesRequestVersion: number;
  usageSessionLogsRequestVersion: number;
  usageTimeZone: "local" | "utc";
  settings?: { gatewayUrl?: string };
};

type DateInterpretationMode = "utc" | "gateway" | "specific";

type UsageDateInterpretationParams = {
  mode: DateInterpretationMode;
  utcOffset?: string;
  timeZone?: string;
};

const LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY = "openclaw.control.usage.date-params.v1";
const LEGACY_USAGE_TIME_ZONE_STORAGE_KEY = "openclaw.control.usage.time-zone.v1";
const LEGACY_USAGE_DATE_PARAMS_DEFAULT_GATEWAY_KEY = "__default__";
const LEGACY_USAGE_DATE_PARAMS_MODE_RE = /unexpected property ['"]mode['"]/i;
const LEGACY_USAGE_DATE_PARAMS_OFFSET_RE = /unexpected property ['"]utcoffset['"]/i;
const LEGACY_USAGE_DATE_PARAMS_TIME_ZONE_RE = /unexpected property ['"]timezone['"]/i;
const LEGACY_USAGE_DATE_PARAMS_INVALID_RE = /invalid sessions\.usage params/i;
const LEGACY_USAGE_DATE_PARAMS_UNSUPPORTED_MESSAGE =
  "This gateway is too old to support Usage time zone filters. Upgrade the gateway to use the Local/UTC toggle.";

let legacyUsageDateParamsCache: Set<string> | null = null;
let legacyUsageTimeZoneCache: Set<string> | null = null;

function getLocalStorage(): Storage | null {
  return getSafeLocalStorage();
}

function loadGatewayCompatibilityCache(storageKey: string, entryKey: string): Set<string> {
  const storage = getLocalStorage();
  if (!storage) {
    return new Set<string>();
  }
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const values = parsed?.[entryKey];
    if (!Array.isArray(values)) {
      return new Set<string>();
    }
    return new Set(
      values
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}

function loadLegacyUsageDateParamsCache(): Set<string> {
  return loadGatewayCompatibilityCache(
    LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY,
    "unsupportedGatewayKeys",
  );
}

function loadLegacyUsageTimeZoneCache(): Set<string> {
  return loadGatewayCompatibilityCache(
    LEGACY_USAGE_TIME_ZONE_STORAGE_KEY,
    "unsupportedTimeZoneGatewayKeys",
  );
}

function persistGatewayCompatibilityCache(
  storageKey: string,
  entryKey: string,
  cache: Set<string>,
) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(storageKey, JSON.stringify({ [entryKey]: Array.from(cache) }));
  } catch {
    // ignore quota/private-mode failures
  }
}

function persistLegacyUsageDateParamsCache(cache: Set<string>) {
  persistGatewayCompatibilityCache(
    LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY,
    "unsupportedGatewayKeys",
    cache,
  );
}

function persistLegacyUsageTimeZoneCache(cache: Set<string>) {
  persistGatewayCompatibilityCache(
    LEGACY_USAGE_TIME_ZONE_STORAGE_KEY,
    "unsupportedTimeZoneGatewayKeys",
    cache,
  );
}

function getLegacyUsageDateParamsCache(): Set<string> {
  if (!legacyUsageDateParamsCache) {
    legacyUsageDateParamsCache = loadLegacyUsageDateParamsCache();
  }
  return legacyUsageDateParamsCache;
}

function getLegacyUsageTimeZoneCache(): Set<string> {
  if (!legacyUsageTimeZoneCache) {
    legacyUsageTimeZoneCache = loadLegacyUsageTimeZoneCache();
  }
  return legacyUsageTimeZoneCache;
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

function shouldSendLegacyTimeZoneName(state: UsageState): boolean {
  return !getLegacyUsageTimeZoneCache().has(resolveGatewayCompatibilityKey(state));
}

function rememberLegacyTimeZoneName(state: UsageState) {
  const cache = getLegacyUsageTimeZoneCache();
  cache.add(resolveGatewayCompatibilityKey(state));
  persistLegacyUsageTimeZoneCache(cache);
}

function isLegacyDateInterpretationUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    (LEGACY_USAGE_DATE_PARAMS_MODE_RE.test(message) ||
      LEGACY_USAGE_DATE_PARAMS_OFFSET_RE.test(message) ||
      LEGACY_USAGE_DATE_PARAMS_TIME_ZONE_RE.test(message))
  );
}

function isLegacyTimeZoneUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    LEGACY_USAGE_DATE_PARAMS_TIME_ZONE_RE.test(message) &&
    !LEGACY_USAGE_DATE_PARAMS_MODE_RE.test(message) &&
    !LEGACY_USAGE_DATE_PARAMS_OFFSET_RE.test(message)
  );
}

const resolveLocalTimeZoneName = (): string | undefined => {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return resolved ? resolved : undefined;
  } catch {
    return undefined;
  }
};

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
  includeTimeZoneName = true,
): UsageDateInterpretationParams | undefined => {
  if (!includeDateInterpretation) {
    return undefined;
  }
  if (timeZone === "utc") {
    return { mode: "utc" };
  }
  const utcOffset = formatUtcOffset(new Date().getTimezoneOffset());
  const localTimeZoneName = resolveLocalTimeZoneName();
  if (includeTimeZoneName && localTimeZoneName) {
    return {
      mode: "specific",
      timeZone: localTimeZoneName,
      utcOffset,
    };
  }
  return {
    mode: "specific",
    utcOffset,
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

function createLegacyUsageDateInterpretationUnsupportedError(): Error {
  return new Error(LEGACY_USAGE_DATE_PARAMS_UNSUPPORTED_MESSAGE);
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
  const requestVersion = bumpRequestVersion(state.usageRequestVersion);
  state.usageRequestVersion = requestVersion;
  state.usageLoading = true;
  state.usageError = null;
  try {
    const startDate = overrides?.startDate ?? state.usageStartDate;
    const endDate = overrides?.endDate ?? state.usageEndDate;
    const usageTimeZone = state.usageTimeZone;
    const includeDateInterpretation = shouldSendLegacyDateInterpretation(state);
    const includeTimeZoneName = shouldSendLegacyTimeZoneName(state);
    if (!includeDateInterpretation && usageTimeZone !== "utc") {
      throw createLegacyUsageDateInterpretationUnsupportedError();
    }
    const runUsageRequests = async (
      includeDateInterpretation: boolean,
      includeTimeZoneName: boolean,
    ) => {
      const dateInterpretation = buildDateInterpretationParams(
        usageTimeZone,
        includeDateInterpretation,
        includeTimeZoneName,
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
      if (state.usageRequestVersion !== requestVersion) {
        return;
      }
      if (sessionsRes) {
        state.usageResult = sessionsRes as SessionsUsageResult;
      }
      if (costRes) {
        state.usageCostSummary = costRes as CostUsageSummary;
      }
    };

    try {
      const [sessionsRes, costRes] = await runUsageRequests(
        includeDateInterpretation,
        includeTimeZoneName,
      );
      applyUsageResults(sessionsRes, costRes);
    } catch (err) {
      if (
        usageTimeZone === "local" &&
        includeDateInterpretation &&
        includeTimeZoneName &&
        isLegacyTimeZoneUnsupportedError(err)
      ) {
        rememberLegacyTimeZoneName(state);
        try {
          const [sessionsRes, costRes] = await runUsageRequests(true, false);
          applyUsageResults(sessionsRes, costRes);
        } catch (offsetErr) {
          if (isLegacyDateInterpretationUnsupportedError(offsetErr)) {
            rememberLegacyDateInterpretation(state);
            throw createLegacyUsageDateInterpretationUnsupportedError();
          }
          throw offsetErr;
        }
        return;
      }
      if (includeDateInterpretation && isLegacyDateInterpretationUnsupportedError(err)) {
        // Older gateways reject date-interpretation fields in `sessions.usage`.
        rememberLegacyDateInterpretation(state);
        if (usageTimeZone === "utc") {
          const [sessionsRes, costRes] = await runUsageRequests(false, false);
          applyUsageResults(sessionsRes, costRes);
        } else {
          throw createLegacyUsageDateInterpretationUnsupportedError();
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (state.usageRequestVersion === requestVersion) {
      state.usageResult = null;
      state.usageCostSummary = null;
      state.usageError = toErrorMessage(err);
    }
  } finally {
    if (state.usageRequestVersion === requestVersion) {
      state.usageLoading = false;
    }
  }
}

export const __test = {
  formatUtcOffset,
  resolveLocalTimeZoneName,
  buildDateInterpretationParams,
  toErrorMessage,
  isLegacyDateInterpretationUnsupportedError,
  isLegacyTimeZoneUnsupportedError,
  normalizeGatewayCompatibilityKey,
  shouldSendLegacyDateInterpretation,
  shouldSendLegacyTimeZoneName,
  rememberLegacyDateInterpretation,
  rememberLegacyTimeZoneName,
  resetLegacyUsageDateParamsCache: () => {
    legacyUsageDateParamsCache = null;
    legacyUsageTimeZoneCache = null;
  },
};

function bumpRequestVersion(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : 1;
}

export function resetSessionUsageDetails(state: UsageState) {
  state.usageTimeSeriesRequestVersion = bumpRequestVersion(state.usageTimeSeriesRequestVersion);
  state.usageSessionLogsRequestVersion = bumpRequestVersion(state.usageSessionLogsRequestVersion);
  state.usageTimeSeriesLoading = false;
  state.usageSessionLogsLoading = false;
  state.usageTimeSeries = null;
  state.usageSessionLogs = null;
}

export async function loadSessionTimeSeries(state: UsageState, sessionKey: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const requestVersion = bumpRequestVersion(state.usageTimeSeriesRequestVersion);
  state.usageTimeSeriesRequestVersion = requestVersion;
  state.usageTimeSeriesLoading = true;
  state.usageTimeSeries = null;
  try {
    const res = await client.request("sessions.usage.timeseries", { key: sessionKey });
    if (state.usageTimeSeriesRequestVersion !== requestVersion) {
      return;
    }
    if (res) {
      state.usageTimeSeries = res as SessionUsageTimeSeries;
    }
  } catch {
    // Silently fail - time series is optional
    if (state.usageTimeSeriesRequestVersion === requestVersion) {
      state.usageTimeSeries = null;
    }
  } finally {
    if (state.usageTimeSeriesRequestVersion === requestVersion) {
      state.usageTimeSeriesLoading = false;
    }
  }
}

export async function loadSessionLogs(state: UsageState, sessionKey: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const requestVersion = bumpRequestVersion(state.usageSessionLogsRequestVersion);
  state.usageSessionLogsRequestVersion = requestVersion;
  state.usageSessionLogsLoading = true;
  state.usageSessionLogs = null;
  try {
    const res = await client.request("sessions.usage.logs", {
      key: sessionKey,
      limit: 1000,
    });
    if (state.usageSessionLogsRequestVersion !== requestVersion) {
      return;
    }
    if (res && Array.isArray((res as { logs: SessionLogEntry[] }).logs)) {
      state.usageSessionLogs = (res as { logs: SessionLogEntry[] }).logs;
    }
  } catch {
    // Silently fail - logs are optional
    if (state.usageSessionLogsRequestVersion === requestVersion) {
      state.usageSessionLogs = null;
    }
  } finally {
    if (state.usageSessionLogsRequestVersion === requestVersion) {
      state.usageSessionLogsLoading = false;
    }
  }
}
