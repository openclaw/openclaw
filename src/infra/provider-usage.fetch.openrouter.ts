import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

// https://openrouter.ai/api/v1/key — returns credit usage/limit for the bearer key.
// `limit`/`usage` are denominated in OpenRouter credits; `limit` is null for
// pay-as-you-go keys (no cap), in which case a percentage window is not meaningful.
type OpenRouterKeyResponse = {
  data?: {
    limit?: number | null;
    limit_remaining?: number | null;
    usage?: number;
  };
};

export async function fetchOpenRouterUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://openrouter.ai/api/v1/key",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    let message: string | undefined;
    try {
      const data = (await res.json()) as {
        error?: { message?: unknown } | null;
      };
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }
    return buildUsageHttpErrorSnapshot({
      provider: "openrouter",
      status: res.status,
      message,
    });
  }

  const { data } = (await res.json()) as OpenRouterKeyResponse;
  const windows: UsageWindow[] = [];
  const limit = data?.limit;
  const usage = data?.usage;
  // Only a capped key yields a meaningful utilization percentage. Pay-as-you-go
  // keys (limit === null) report spend but no denominator, so emit no window.
  if (typeof limit === "number" && limit > 0 && typeof usage === "number") {
    windows.push({
      label: "Credits",
      usedPercent: clampPercent((usage / limit) * 100),
    });
  }

  return {
    provider: "openrouter",
    displayName: PROVIDER_LABELS.openrouter,
    windows,
  };
}
