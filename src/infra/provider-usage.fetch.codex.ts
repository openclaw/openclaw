import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { omitNullRequestHeaders } from "../../packages/llm-core/src/utils/request-headers.js";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { fetchUsageJson } from "./provider-usage.fetch.shared.js";
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

const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

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

  const parsed = await fetchUsageJson({
    provider: "openai",
    url: "https://chatgpt.com/backend-api/wham/usage",
    init: { method: "GET", headers: omitNullRequestHeaders(headers) },
    timeoutMs,
    fetchFn,
    tokenExpiredStatuses: [401, 403],
  });
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = parsed.data as CodexUsageResponse;
  const windows: UsageWindow[] = [];

  for (const kind of ["primary_window", "secondary_window"] as const) {
    const window = data.rate_limit?.[kind];
    if (!window) {
      continue;
    }
    const primary = kind === "primary_window";
    const windowHours = Math.round(
      (window.limit_window_seconds || (primary ? 10800 : 86400)) / 3600,
    );
    const primaryResetAt = data.rate_limit?.primary_window?.reset_at;
    // Codex occasionally reports 24h with weekly reset cadence.
    const label =
      primary || windowHours < 24
        ? `${windowHours}h`
        : windowHours >= 168 ||
            (typeof window.reset_at === "number" &&
              typeof primaryResetAt === "number" &&
              window.reset_at - primaryResetAt >= WEEKLY_RESET_GAP_SECONDS)
          ? "Week"
          : "Day";
    windows.push({
      label,
      usedPercent: clampPercent(window.used_percent || 0),
      resetAt: window.reset_at ? window.reset_at * 1000 : undefined,
    });
  }

  const plan = data.plan_type;
  let billing: ProviderUsageSnapshot["billing"];
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : parseStrictFiniteNumber(data.credits.balance);
    if (balance !== undefined && balance >= 0) {
      billing = [{ type: "balance", amount: balance, unit: "credits" }];
    }
  }

  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    plan,
    ...(billing ? { billing } : {}),
  };
}
