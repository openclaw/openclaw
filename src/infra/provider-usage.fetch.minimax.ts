import { fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageWindow,
} from "./provider-usage.types.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type MinimaxUsageResponse = {
  base_resp?: MinimaxBaseResp;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

const RESET_KEYS = [
  "reset_at",
  "resetAt",
  "reset_time",
  "resetTime",
  "expires_at",
  "expiresAt",
  "expire_at",
  "expireAt",
  "end_time",
  "endTime",
  "window_end",
  "windowEnd",
] as const;

const PERCENT_KEYS = [
  "used_percent",
  "usedPercent",
  "usage_percent",
  "usagePercent",
  "used_rate",
  "usage_rate",
  "used_ratio",
  "usage_ratio",
  "usedRatio",
  "usageRatio",
] as const;

const USED_KEYS = [
  "used",
  "usage",
  "used_amount",
  "usedAmount",
  "used_tokens",
  "usedTokens",
  "used_quota",
  "usedQuota",
  "used_times",
  "usedTimes",
  "consumed",
] as const;

const TOTAL_KEYS = [
  "total",
  "total_amount",
  "totalAmount",
  "total_tokens",
  "totalTokens",
  "total_quota",
  "totalQuota",
  "total_times",
  "totalTimes",
  "limit",
  "quota",
  "quota_limit",
  "quotaLimit",
  "max",
] as const;

const REMAINING_KEYS = [
  "remain",
  "remaining",
  "remain_amount",
  "remainingAmount",
  "remaining_amount",
  "remain_tokens",
  "remainingTokens",
  "remaining_tokens",
  "remain_quota",
  "remainingQuota",
  "remaining_quota",
  "remain_times",
  "remainingTimes",
  "remaining_times",
  "left",
] as const;

const PLAN_KEYS = ["plan", "plan_name", "planName", "product", "tier"] as const;

const WINDOW_HOUR_KEYS = [
  "window_hours",
  "windowHours",
  "duration_hours",
  "durationHours",
  "hours",
] as const;

const WINDOW_MINUTE_KEYS = [
  "window_minutes",
  "windowMinutes",
  "duration_minutes",
  "durationMinutes",
  "minutes",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 1e12) return Math.floor(value * 1000);
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function deriveWindowLabel(payload: Record<string, unknown>): string {
  const hours = pickNumber(payload, WINDOW_HOUR_KEYS);
  if (hours && Number.isFinite(hours)) return `${hours}h`;
  const minutes = pickNumber(payload, WINDOW_MINUTE_KEYS);
  if (minutes && Number.isFinite(minutes)) return `${minutes}m`;
  return "5h";
}

function deriveUsedPercent(payload: Record<string, unknown>): number | null {
  const percentRaw = pickNumber(payload, PERCENT_KEYS);
  if (percentRaw !== undefined) {
    const normalized = percentRaw <= 1 ? percentRaw * 100 : percentRaw;
    return clampPercent(normalized);
  }

  const total = pickNumber(payload, TOTAL_KEYS);
  if (!total || total <= 0) return null;
  let used = pickNumber(payload, USED_KEYS);
  if (used === undefined) {
    const remaining = pickNumber(payload, REMAINING_KEYS);
    if (remaining !== undefined) used = total - remaining;
  }
  if (used === undefined || !Number.isFinite(used)) return null;
  return clampPercent((used / total) * 100);
}

export async function fetchMinimaxUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.minimax.io/v1/coding_plan/remains",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "Clawdbot",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json().catch(() => null)) as MinimaxUsageResponse;
  if (!isRecord(data)) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: "Invalid JSON",
    };
  }

  const baseResp = isRecord(data.base_resp)
    ? (data.base_resp as MinimaxBaseResp)
    : undefined;
  if (
    baseResp &&
    typeof baseResp.status_code === "number" &&
    baseResp.status_code !== 0
  ) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: baseResp.status_msg?.trim() || "API error",
    };
  }

  const payload = isRecord(data.data) ? data.data : data;
  const usedPercent = deriveUsedPercent(payload);
  if (usedPercent === null) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: "Unsupported response shape",
    };
  }

  const resetAt =
    parseEpoch(pickString(payload, RESET_KEYS)) ??
    parseEpoch(pickNumber(payload, RESET_KEYS));
  const windows: UsageWindow[] = [
    {
      label: deriveWindowLabel(payload),
      usedPercent,
      resetAt,
    },
  ];

  return {
    provider: "minimax",
    displayName: PROVIDER_LABELS.minimax,
    windows,
    plan: pickString(payload, PLAN_KEYS),
  };
}
