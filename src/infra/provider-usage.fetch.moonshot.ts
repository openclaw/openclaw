import { isRecord } from "../utils.js";
import { fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

const KIMI_BILLING_ENDPOINT =
  "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages";
const KIMI_BILLING_SCOPE_CODING = 4;

const MOONSHOT_USAGE_ENDPOINTS = [
  "https://api.moonshot.ai/v1/users/me/balance",
  "https://api.moonshot.cn/v1/users/me/balance",
] as const;

const PERCENT_KEYS = [
  "used_percent",
  "usedPercent",
  "usage_percent",
  "usagePercent",
  "percent",
  "percentage",
] as const;

const TOTAL_KEYS = [
  "total",
  "total_balance",
  "totalBalance",
  "total_amount",
  "totalAmount",
  "quota",
  "quota_limit",
  "quotaLimit",
  "limit",
] as const;

const USED_KEYS = ["used", "used_amount", "usedAmount", "usage", "consumed"] as const;

const REMAINING_KEYS = [
  "remaining",
  "remain",
  "remaining_balance",
  "remainingBalance",
  "available",
  "available_balance",
  "availableBalance",
  "balance",
] as const;

const PLAN_KEYS = ["plan", "plan_name", "planName", "tier", "currency"] as const;

type KimiGatewayUsageResponse = {
  usages?: Array<{
    scope?: string;
    detail?: {
      limit?: string;
      used?: string;
      remaining?: string;
      resetTime?: string;
    };
    limits?: Array<{
      window?: {
        duration?: number;
        timeUnit?: string;
      };
      detail?: {
        limit?: string;
        used?: string;
        remaining?: string;
        resetTime?: string;
      };
    }>;
  }>;
};

type MoonshotError = {
  error?: {
    message?: string;
    type?: string;
  };
  code?: string;
  details?: Array<{ debug?: { reason?: string } }>;
  message?: string;
  msg?: string;
};

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function deriveUsedPercent(record: Record<string, unknown>): number | null {
  const percent = pickNumber(record, PERCENT_KEYS);
  if (percent !== undefined) {
    return clampPercent(percent <= 1 ? percent * 100 : percent);
  }

  const total = pickNumber(record, TOTAL_KEYS);
  let used = pickNumber(record, USED_KEYS);
  const remaining = pickNumber(record, REMAINING_KEYS);

  if (used === undefined && total !== undefined && remaining !== undefined) {
    used = total - remaining;
  }

  if (total !== undefined && total > 0 && used !== undefined) {
    return clampPercent((used / total) * 100);
  }

  return null;
}

function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetTime(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function kimiWindowLabel(duration?: number, timeUnit?: string): string {
  if (!duration || !timeUnit) {
    return "Window";
  }
  if (timeUnit === "TIME_UNIT_MINUTE") {
    return `${duration}m`;
  }
  if (timeUnit === "TIME_UNIT_HOUR") {
    return `${duration}h`;
  }
  if (timeUnit === "TIME_UNIT_DAY") {
    return `${duration}d`;
  }
  return `Window`;
}

function parseKimiGatewayWindows(json: KimiGatewayUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const usage = json.usages?.[0];
  if (!usage) {
    return windows;
  }

  const topLimit = parseNumberLike(usage.detail?.limit);
  const topUsed = parseNumberLike(usage.detail?.used);
  if (topLimit && topLimit > 0 && topUsed !== undefined) {
    windows.push({
      label: "Cycle",
      usedPercent: clampPercent((topUsed / topLimit) * 100),
      resetAt: parseResetTime(usage.detail?.resetTime),
    });
  }

  for (const limit of usage.limits ?? []) {
    const max = parseNumberLike(limit.detail?.limit);
    const used = parseNumberLike(limit.detail?.used);
    if (!max || max <= 0 || used === undefined) {
      continue;
    }
    windows.push({
      label: kimiWindowLabel(limit.window?.duration, limit.window?.timeUnit),
      usedPercent: clampPercent((used / max) * 100),
      resetAt: parseResetTime(limit.detail?.resetTime),
    });
  }

  return windows;
}

function collectCandidateRecords(root: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [root];

  const data = root.data;
  if (isRecord(data)) {
    out.push(data);
  }

  const account = root.account;
  if (isRecord(account)) {
    out.push(account);
  }

  const balance = root.balance;
  if (isRecord(balance)) {
    out.push(balance);
  }

  if (isRecord(data)) {
    const nestedBalance = data.balance;
    if (isRecord(nestedBalance)) {
      out.push(nestedBalance);
    }
  }

  return out;
}

async function fetchKimiGatewayUsageRaw(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ endpoint: string; response: Response }> {
  const kimiBearer =
    process.env.KIMI_BILLING_BEARER_TOKEN?.trim() ||
    process.env.KIMI_WEB_AUTH_TOKEN?.trim() ||
    apiKey;
  const response = await fetchJson(
    KIMI_BILLING_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kimiBearer}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: [KIMI_BILLING_SCOPE_CODING] }),
    },
    timeoutMs,
    fetchFn,
  );
  return { endpoint: KIMI_BILLING_ENDPOINT, response };
}

/**
 * Moonshot quota fetch with multi-endpoint fallback strategy:
 * 1) Try Kimi billing endpoint (best structured coding windows)
 * 2) Fall back to Moonshot global balance endpoint
 * 3) Fall back to Moonshot CN balance endpoint
 *
 * Returns the first successful response, or the most actionable failure.
 */
async function fetchMoonshotUsageRaw(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ endpoint: string; response: Response }> {
  const attempts: Array<{ endpoint: string; response: Response }> = [];

  // First try Kimi billing API endpoint.
  const kimi = await fetchKimiGatewayUsageRaw(apiKey, timeoutMs, fetchFn);
  attempts.push(kimi);
  if (kimi.response.ok) {
    return kimi;
  }

  // Then fallback to Moonshot balance endpoints.
  for (const endpoint of MOONSHOT_USAGE_ENDPOINTS) {
    const response = await fetchJson(
      endpoint,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      timeoutMs,
      fetchFn,
    );
    attempts.push({ endpoint, response });

    if (response.ok) {
      return { endpoint, response };
    }
  }

  // Prefer the most actionable non-404 failure if no endpoint succeeded.
  const prioritized = attempts.find((a) => a.response.status !== 404) ?? attempts[0];
  return prioritized;
}

export async function fetchMoonshotUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const { endpoint, response } = await fetchMoonshotUsageRaw(apiKey, timeoutMs, fetchFn);

  if (!response.ok) {
    let message: string | undefined;
    let reason: string | undefined;
    try {
      const payload = (await response.json()) as MoonshotError;
      message = payload?.error?.message || payload?.message || payload?.msg;
      reason = payload?.details?.[0]?.debug?.reason || payload?.code;
    } catch {
      // ignore
    }

    const error =
      response.status === 401 || response.status === 403
        ? endpoint.includes("kimi.com")
          ? `HTTP ${response.status}: Kimi billing endpoint rejected this token (${reason || "invalid auth token"}). This endpoint may require a web-session auth token instead of API key.`
          : `HTTP ${response.status}: Moonshot rejected the configured key for usage endpoint (${endpoint}).`
        : message
          ? `HTTP ${response.status}: ${message}`
          : `HTTP ${response.status}`;

    return {
      provider: "moonshot",
      displayName: PROVIDER_LABELS.moonshot,
      windows: [],
      error,
      plan: endpoint.includes("moonshot.cn")
        ? "CN"
        : endpoint.includes("kimi.com")
          ? "Kimi"
          : "Global",
    };
  }

  const json = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(json)) {
    return {
      provider: "moonshot",
      displayName: PROVIDER_LABELS.moonshot,
      windows: [],
      error: "Invalid JSON",
      plan: endpoint.includes("moonshot.cn")
        ? "CN"
        : endpoint.includes("kimi.com")
          ? "Kimi"
          : "Global",
    };
  }

  if (endpoint.includes("kimi.com")) {
    const kimiWindows = parseKimiGatewayWindows(json as KimiGatewayUsageResponse);
    if (kimiWindows.length > 0) {
      return {
        provider: "moonshot",
        displayName: PROVIDER_LABELS.moonshot,
        windows: kimiWindows,
        plan: "Kimi",
      };
    }
  }

  const records = collectCandidateRecords(json);
  let selected: Record<string, unknown> | undefined;
  let usedPercent: number | null = null;

  for (const candidate of records) {
    const pct = deriveUsedPercent(candidate);
    if (pct !== null) {
      selected = candidate;
      usedPercent = pct;
      break;
    }
  }

  if (usedPercent === null) {
    return {
      provider: "moonshot",
      displayName: PROVIDER_LABELS.moonshot,
      windows: [],
      error: "No usage window data returned by Moonshot API",
      plan: endpoint.includes("moonshot.cn")
        ? "CN"
        : endpoint.includes("kimi.com")
          ? "Kimi"
          : "Global",
    };
  }

  const windows: UsageWindow[] = [
    {
      label: "Balance",
      usedPercent,
    },
  ];

  const plan =
    (selected ? pickString(selected, PLAN_KEYS) : undefined) ||
    pickString(json, PLAN_KEYS) ||
    (endpoint.includes("moonshot.cn") ? "CN" : "Global");

  return {
    provider: "moonshot",
    displayName: PROVIDER_LABELS.moonshot,
    windows,
    plan,
  };
}
