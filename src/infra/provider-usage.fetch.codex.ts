// Fetches Codex provider usage windows.
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { parseStrictFiniteNumber } from "./parse-finite-number.js";
import {
  buildUsageHttpErrorSnapshot,
  fetchJson,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type CodexUsageResponse = {
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

type JsonObject = Record<string, unknown>;
type CodexAppServerRateLimitWindow = {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number;
  window_duration_mins?: number;
  windowMinutes?: number;
  window_minutes?: number;
  resetsAt?: number | null;
  resets_at?: number | null;
};

const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

function resolveSecondaryWindowLabel(params: {
  windowHours: number;
  secondaryResetAt?: number;
  primaryResetAt?: number;
}): string {
  if (params.windowHours >= 168) {
    return "Week";
  }
  if (params.windowHours < 24) {
    return `${params.windowHours}h`;
  }
  // Codex occasionally reports a 24h secondary window while exposing a
  // weekly reset cadence in reset timestamps. Prefer cadence in that case.
  if (
    typeof params.secondaryResetAt === "number" &&
    typeof params.primaryResetAt === "number" &&
    params.secondaryResetAt - params.primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return "Week";
  }
  return "Day";
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAppServerWindow(
  snapshot: JsonObject,
  key: "primary" | "secondary",
): CodexAppServerRateLimitWindow | undefined {
  const value = snapshot[key];
  return isJsonObject(value) ? (value as CodexAppServerRateLimitWindow) : undefined;
}

function isAppServerRateLimitSnapshot(value: JsonObject): boolean {
  return (
    isJsonObject(value.primary) ||
    isJsonObject(value.secondary) ||
    value.limitId !== undefined ||
    value.limit_id !== undefined ||
    value.limitName !== undefined ||
    value.limit_name !== undefined
  );
}

function collectAppServerRateLimitSnapshots(value: unknown, snapshots: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAppServerRateLimitSnapshots(entry, snapshots);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const byLimitId = value.rateLimitsByLimitId ?? value.rate_limits_by_limit_id;
  if (isJsonObject(byLimitId)) {
    const codex = byLimitId.codex;
    if (isJsonObject(codex)) {
      collectAppServerRateLimitSnapshots(codex, snapshots);
    }
    for (const entry of Object.values(byLimitId)) {
      if (entry !== codex) {
        collectAppServerRateLimitSnapshots(entry, snapshots);
      }
    }
  }
  collectAppServerRateLimitSnapshots(value.rateLimits ?? value.rate_limits, snapshots);
  if (isAppServerRateLimitSnapshot(value)) {
    snapshots.push(value);
  }
}

function selectCodexAppServerRateLimitSnapshot(value: unknown): JsonObject | undefined {
  const snapshots: JsonObject[] = [];
  collectAppServerRateLimitSnapshots(value, snapshots);
  return (
    snapshots.find((snapshot) => {
      const id = readString(snapshot.limitId) ?? readString(snapshot.limit_id);
      return !id || id === "codex";
    }) ?? snapshots[0]
  );
}

function resolveAppServerWindowLabel(
  window: CodexAppServerRateLimitWindow,
  fallback: "primary" | "secondary",
): string {
  const minutes =
    readNumber(window.windowDurationMins) ??
    readNumber(window.window_duration_mins) ??
    readNumber(window.windowMinutes) ??
    readNumber(window.window_minutes);
  if (minutes === 7 * 24 * 60) {
    return "Week";
  }
  if (minutes === 24 * 60) {
    return "Day";
  }
  if (minutes !== undefined && minutes > 0 && minutes < 24 * 60) {
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return fallback === "primary" ? "Short" : "Long";
}

function readAppServerUsageWindow(
  snapshot: JsonObject,
  key: "primary" | "secondary",
): UsageWindow | undefined {
  const window = readAppServerWindow(snapshot, key);
  if (!window) {
    return undefined;
  }
  const usedPercent = readNumber(window.usedPercent) ?? readNumber(window.used_percent);
  const resetsAt =
    readNumber(window.resetsAt ?? undefined) ?? readNumber(window.resets_at ?? undefined);
  if (usedPercent === undefined && resetsAt === undefined) {
    return undefined;
  }
  return {
    label: resolveAppServerWindowLabel(window, key),
    usedPercent: clampPercent(usedPercent ?? 0),
    resetAt: resetsAt ? resetsAt * 1000 : undefined,
  };
}

function resolveAppServerPlan(snapshot: JsonObject): string | undefined {
  const plan = readString(snapshot.planType) ?? readString(snapshot.plan_type);
  const credits = isJsonObject(snapshot.credits) ? snapshot.credits : undefined;
  const rawBalance = credits?.balance;
  if (rawBalance === undefined || rawBalance === null) {
    return plan;
  }
  const balance =
    typeof rawBalance === "number"
      ? rawBalance
      : (parseStrictFiniteNumber(String(rawBalance)) ?? 0);
  return plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
}

/** Converts Codex app-server rate-limit payloads into OpenAI/Codex usage windows. */
export function buildCodexAppServerUsageSnapshot(value: unknown): ProviderUsageSnapshot {
  const snapshot = selectCodexAppServerRateLimitSnapshot(value);
  const windows = snapshot
    ? (["primary", "secondary"] as const)
        .map((key) => readAppServerUsageWindow(snapshot, key))
        .filter((window): window is UsageWindow => Boolean(window))
    : [];
  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    ...(snapshot ? { plan: resolveAppServerPlan(snapshot) } : {}),
  };
}

export async function fetchCodexUsage(
  token: string,
  accountId: string | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  const defaultHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": `openclaw/${version || "dev"}`,
  };
  if (accountId) {
    defaultHeaders["ChatGPT-Account-Id"] = accountId;
  }
  const headers =
    resolveProviderRequestHeaders({
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/wham/usage",
      capability: "other",
      transport: "http",
      defaultHeaders,
    }) ?? defaultHeaders;

  const res = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider: "openai",
      status: res.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  const parsed = await readUsageJson("openai", res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = parsed.data as CodexUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(pw.used_percent || 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
    const label = resolveSecondaryWindowLabel({
      windowHours,
      primaryResetAt: data.rate_limit?.primary_window?.reset_at,
      secondaryResetAt: sw.reset_at,
    });
    windows.push({
      label,
      usedPercent: clampPercent(sw.used_percent || 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : (parseStrictFiniteNumber(data.credits.balance) ?? 0);
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    plan,
  };
}
