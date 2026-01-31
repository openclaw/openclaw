import { fetchJson } from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

/**
 * Fetch usage data from Infini AI.
 * Note: The usage API endpoint is not yet available (returns 404).
 * This implementation returns empty windows until the API is ready.
 */
export async function fetchInfiniUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  try {
    // Attempt to fetch usage data from the dashboard API
    const res = await fetchJson(
      "https://cloud.infini-ai.com/maas/v1/dashboard/billing/usage",
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

    // If the endpoint returns 404, return empty windows without error
    if (res.status === 404) {
      return {
        provider: "infini",
        displayName: PROVIDER_LABELS.infini,
        windows: [],
      };
    }

    if (!res.ok) {
      return {
        provider: "infini",
        displayName: PROVIDER_LABELS.infini,
        windows: [],
        error: `HTTP ${res.status}`,
      };
    }

    // If we get a successful response, parse it
    // TODO: Update this when the actual API response format is known
    const data = await res.json();

    return {
      provider: "infini",
      displayName: PROVIDER_LABELS.infini,
      windows: [],
      plan: data.plan,
    };
  } catch {
    // Return empty windows on error to avoid disrupting other providers
    return {
      provider: "infini",
      displayName: PROVIDER_LABELS.infini,
      windows: [],
    };
  }
}
