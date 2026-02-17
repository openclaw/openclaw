import { fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type CopilotUsageResponse = {
  quota_snapshots?: {
    premium_interactions?: { percent_remaining?: number | null };
    chat?: { percent_remaining?: number | null };
  };
  // GitHub has changed this payload shape at least once. Newer responses appear to
  // include monthly quota objects plus a reset date.
  //
  // Observed keys (2026): monthly_quotas, limited_user_quotas, limited_user_reset_date.
  monthly_quotas?: {
    chat?: number | null;
    completions?: number | null;
  };
  limited_user_quotas?: {
    chat?: number | null;
    completions?: number | null;
  };
  limited_user_reset_date?: string | null; // YYYY-MM-DD
  copilot_plan?: string;
};

function parseResetDateMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  // Interpret YYYY-MM-DD as UTC start-of-day. It's good enough for a countdown.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function computeUsedPercentFromQuota(params: {
  total?: number | null;
  remaining?: number | null;
}): number | null {
  const total = params.total;
  const remaining = params.remaining;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) {
    return null;
  }
  return clampPercent(100 - (remaining / total) * 100);
}

export async function fetchCopilotUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.github.com/copilot_internal/user",
    {
      headers: {
        Authorization: `token ${token}`,
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider: "github-copilot",
      displayName: PROVIDER_LABELS["github-copilot"],
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as CopilotUsageResponse;
  const windows: UsageWindow[] = [];
  const monthlyResetAt = parseResetDateMs(data.limited_user_reset_date);

  if (data.quota_snapshots?.premium_interactions) {
    const remaining = data.quota_snapshots.premium_interactions.percent_remaining;
    windows.push({
      label: "Premium",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  if (data.quota_snapshots?.chat) {
    const remaining = data.quota_snapshots.chat.percent_remaining;
    windows.push({
      label: "Chat",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  // Newer schema: total monthly quotas + remaining quotas.
  const chatUsed = computeUsedPercentFromQuota({
    total: data.monthly_quotas?.chat,
    remaining: data.limited_user_quotas?.chat,
  });
  if (chatUsed !== null) {
    windows.push({
      label: "Chat (month)",
      usedPercent: chatUsed,
      resetAt: monthlyResetAt,
    });
  }

  const completionsUsed = computeUsedPercentFromQuota({
    total: data.monthly_quotas?.completions,
    remaining: data.limited_user_quotas?.completions,
  });
  if (completionsUsed !== null) {
    windows.push({
      label: "Completions (month)",
      usedPercent: completionsUsed,
      resetAt: monthlyResetAt,
    });
  }

  // If we got a 200 but couldn't parse any quota window, surface it as an error so
  // the UI doesn't misleadingly show "No usage windows."
  if (windows.length === 0) {
    return {
      provider: "github-copilot",
      displayName: PROVIDER_LABELS["github-copilot"],
      windows: [],
      plan: data.copilot_plan,
      error: "Unsupported Copilot usage schema",
    };
  }

  return {
    provider: "github-copilot",
    displayName: PROVIDER_LABELS["github-copilot"],
    windows,
    plan: data.copilot_plan,
  };
}
