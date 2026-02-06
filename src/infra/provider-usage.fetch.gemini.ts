import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";
import { fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";

type GeminiUsageResponse = {
  buckets?: Array<{ modelId?: string; remainingFraction?: number; resetTime?: string }>;
};

export async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider,
      displayName: PROVIDER_LABELS[provider],
      windows: [],
      error: res.status === 401 ? "Token expired" : `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as GeminiUsageResponse;
  const windows: UsageWindow[] = [];

  for (const bucket of data.buckets || []) {
    const modelId = bucket.modelId;
    if (!modelId) {
      continue;
    }

    // Skip internal models (prefixed with chat_ or tab_)
    const lower = modelId.toLowerCase();
    if (lower.startsWith("chat_") || lower.startsWith("tab_")) {
      continue;
    }

    const frac = bucket.remainingFraction ?? 1;
    const usedPercent = clampPercent((1 - frac) * 100);

    const window: UsageWindow = { label: modelId, usedPercent };
    if (bucket.resetTime) {
      const resetMs = Date.parse(bucket.resetTime);
      if (Number.isFinite(resetMs)) {
        window.resetAt = resetMs;
      }
    }
    windows.push(window);
  }

  // Sort by usage (highest first) and limit to top 10
  windows.sort((a, b) => b.usedPercent - a.usedPercent);
  const topWindows = windows.slice(0, 10);

  return { provider, displayName: PROVIDER_LABELS[provider], windows: topWindows };
}

