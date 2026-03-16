import { getSafeLocalStorage } from "../../local-storage.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SessionsUsageResult,
  CostUsageSummary,
  ProviderUsageSummary,
  SessionUsageTimeSeries,
} from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageProviderSummary: ProviderUsageSummary | null;
  usageProviderSummaryError: string | null;
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

type LegacyUnsupportedGatewayCache = {
  unsupportedGatewayKeys?: Array<{
    key?: unknown;
    unsupportedUntil?: unknown;
  }>;
};

type UsageQuotaMeta = {
  gatewayKey: string;
  status: "loaded" | "error" | "unsupported";
};

const LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY = "openclaw.control.usage.date-params.v1";
const LEGACY_USAGE_DATE_PARAMS_DEFAULT_GATEWAY_KEY = "__default__";
const LEGACY_USAGE_STATUS_STORAGE_KEY = "openclaw.control.usage.status.v1";
const LEGACY_USAGE_DATE_PARAMS_MODE_RE = /unexpected property ['"]mode['"]/i;
const LEGACY_USAGE_DATE_PARAMS_OFFSET_RE = /unexpected property ['"]utcoffset['"]/i;
const LEGACY_USAGE_DATE_PARAMS_INVALID_RE = /invalid sessions\.usage params/i;
const LEGACY_USAGE_STATUS_UNSUPPORTED_RE =
  /(?:method|rpc)(?:\s+\w+)*\s+not\s+found|unknown method|unknown rpc method|unsupported method/i;
const LEGACY_USAGE_STATUS_RETRY_MS = 5 * 60 * 1000;

let legacyUsageDateParamsCache: Set<string> | null = null;
let legacyUsageStatusCache: Map<string, number> | null = null;
let usageQuotaMeta = new WeakMap<UsageState, UsageQuotaMeta>();

function getLocalStorage(): Storage | null {
  return getSafeLocalStorage();
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

function loadLegacyUsageStatusCache(now: number = Date.now()): Map<string, number> {
  const storage = getLocalStorage();
  if (!storage) {
    return new Map<string, number>();
  }
  try {
    const raw = storage.getItem(LEGACY_USAGE_STATUS_STORAGE_KEY);
    if (!raw) {
      return new Map<string, number>();
    }
    const parsed = JSON.parse(raw) as LegacyUnsupportedGatewayCache | null;
    if (!parsed || !Array.isArray(parsed.unsupportedGatewayKeys)) {
      return new Map<string, number>();
    }
    const cache = new Map<string, number>();
    for (const entry of parsed.unsupportedGatewayKeys) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      const unsupportedUntil =
        typeof entry.unsupportedUntil === "number" ? entry.unsupportedUntil : NaN;
      if (!key || !Number.isFinite(unsupportedUntil) || unsupportedUntil <= now) {
        continue;
      }
      cache.set(key, unsupportedUntil);
    }
    return cache;
  } catch {
    return new Map<string, number>();
  }
}

function persistLegacyUsageStatusCache(cache: Map<string, number>, now: number = Date.now()) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    const unsupportedGatewayKeys = Array.from(cache.entries())
      .filter(([, unsupportedUntil]) => unsupportedUntil > now)
      .map(([key, unsupportedUntil]) => ({ key, unsupportedUntil }));
    storage.setItem(LEGACY_USAGE_STATUS_STORAGE_KEY, JSON.stringify({ unsupportedGatewayKeys }));
  } catch {
    // ignore quota/private-mode failures
  }
}

function getLegacyUsageStatusCache(now: number = Date.now()): Map<string, number> {
  if (!legacyUsageStatusCache) {
    legacyUsageStatusCache = loadLegacyUsageStatusCache(now);
    return legacyUsageStatusCache;
  }
  pruneExpiredLegacyUsageStatusCache(legacyUsageStatusCache, now);
  return legacyUsageStatusCache;
}

function pruneExpiredLegacyUsageStatusCache(cache: Map<string, number>, now: number) {
  for (const [key, unsupportedUntil] of cache.entries()) {
    if (unsupportedUntil <= now) {
      cache.delete(key);
    }
  }
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

function shouldRequestUsageStatus(state: UsageState, now: number = Date.now()): boolean {
  const cache = getLegacyUsageStatusCache(now);
  const key = resolveGatewayCompatibilityKey(state);
  const unsupportedUntil = cache.get(key);
  if (!unsupportedUntil) {
    return true;
  }
  if (unsupportedUntil <= now) {
    cache.delete(key);
    persistLegacyUsageStatusCache(cache, now);
    return true;
  }
  return false;
}

function rememberLegacyUsageStatus(
  state: UsageState,
  now: number = Date.now(),
  retryAfterMs: number = LEGACY_USAGE_STATUS_RETRY_MS,
) {
  const cache = getLegacyUsageStatusCache(now);
  cache.set(resolveGatewayCompatibilityKey(state), now + retryAfterMs);
  persistLegacyUsageStatusCache(cache, now);
}

function forgetLegacyUsageStatus(state: UsageState, now: number = Date.now()) {
  const cache = getLegacyUsageStatusCache(now);
  if (!cache.delete(resolveGatewayCompatibilityKey(state))) {
    return;
  }
  persistLegacyUsageStatusCache(cache, now);
}

function isLegacyDateInterpretationUnsupportedError(err: unknown): boolean {
  const message = toErrorMessage(err);
  return (
    LEGACY_USAGE_DATE_PARAMS_INVALID_RE.test(message) &&
    (LEGACY_USAGE_DATE_PARAMS_MODE_RE.test(message) ||
      LEGACY_USAGE_DATE_PARAMS_OFFSET_RE.test(message))
  );
}

function isLegacyUsageStatusUnsupportedError(err: unknown): boolean {
  return LEGACY_USAGE_STATUS_UNSUPPORTED_RE.test(toErrorMessage(err));
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
    refreshProviderQuota?: boolean;
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
  const gatewayKey = resolveGatewayCompatibilityKey(state);
  const loadProviderQuota = async () => {
    const quotaMetaForState = usageQuotaMeta.get(state);
    const shouldRefreshProviderQuota = overrides?.refreshProviderQuota === true;
    const shouldProbeCompatibility =
      shouldRefreshProviderQuota || shouldRequestUsageStatus(state);
    const shouldLoadQuota =
      shouldRefreshProviderQuota ||
      !quotaMetaForState ||
      quotaMetaForState.gatewayKey !== gatewayKey ||
      quotaMetaForState.status === "error" ||
      (quotaMetaForState.status === "unsupported" && shouldProbeCompatibility);
    if (!shouldLoadQuota) {
      state.usageProviderSummaryError =
        quotaMetaForState?.status === "error" ? state.usageProviderSummaryError : null;
      return;
    }
    state.usageProviderSummaryError = null;
    if (!shouldProbeCompatibility) {
      state.usageProviderSummary = null;
      state.usageProviderSummaryError = null;
      usageQuotaMeta.set(state, { gatewayKey, status: "unsupported" });
      return;
    }
    try {
      const quotaRes = await client.request("usage.status");
      // Discard the result if the client changed while the request was in-flight
      // (e.g. the user switched gateways before it completed).
      if (state.client !== client) {
        return;
      }
      forgetLegacyUsageStatus(state);
      state.usageProviderSummary = quotaRes as ProviderUsageSummary;
      state.usageProviderSummaryError = null;
      usageQuotaMeta.set(state, { gatewayKey, status: "loaded" });
    } catch (err) {
      if (state.client !== client) {
        return;
      }
      if (isLegacyUsageStatusUnsupportedError(err)) {
        rememberLegacyUsageStatus(state);
        state.usageProviderSummary = null;
        state.usageProviderSummaryError = null;
        usageQuotaMeta.set(state, { gatewayKey, status: "unsupported" });
        return;
      }
      forgetLegacyUsageStatus(state);
      state.usageProviderSummary = null;
      state.usageProviderSummaryError = toErrorMessage(err);
      usageQuotaMeta.set(state, { gatewayKey, status: "error" });
    }
  };
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
  void loadProviderQuota();
}

export const __test = {
  LEGACY_USAGE_STATUS_RETRY_MS,
  formatUtcOffset,
  buildDateInterpretationParams,
  toErrorMessage,
  isLegacyDateInterpretationUnsupportedError,
  normalizeGatewayCompatibilityKey,
  shouldSendLegacyDateInterpretation,
  rememberLegacyDateInterpretation,
  shouldRequestUsageStatus,
  rememberLegacyUsageStatus,
  forgetLegacyUsageStatus,
  isLegacyUsageStatusUnsupportedError,
  resetLegacyUsageDateParamsCache: () => {
    legacyUsageDateParamsCache = null;
    legacyUsageStatusCache = null;
    usageQuotaMeta = new WeakMap<UsageState, UsageQuotaMeta>();
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
