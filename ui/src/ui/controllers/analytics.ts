import type { GatewayBrowserClient } from "../gateway.js";
import type { CostUsageSummary, ProviderQuota, UsageSummary } from "../views/analytics.js";

export type AnalyticsState = {
  client: GatewayBrowserClient;
  analyticsLoading: boolean;
  analyticsError: string | null;
  analyticsData: CostUsageSummary | null;
  analyticsQuota: ProviderQuota[] | null;
  analyticsDays: number;
};

export async function loadAnalytics(state: AnalyticsState): Promise<void> {
  state.analyticsLoading = true;
  state.analyticsError = null;

  try {
    // Fetch both cost and quota data in parallel
    const [costRes, quotaRes] = await Promise.all([
      state.client.request("usage.cost", {
        days: state.analyticsDays,
      }) as Promise<CostUsageSummary | undefined>,
      state.client.request("usage.status", {}) as Promise<UsageSummary | undefined>,
    ]);

    if (costRes) {
      state.analyticsData = costRes;
    }

    if (quotaRes?.providers) {
      state.analyticsQuota = quotaRes.providers.map((p) => ({
        provider: p.provider,
        displayName: p.displayName,
        windows: p.windows,
        plan: p.plan,
        error: p.error,
      }));
    }

    if (!costRes && !quotaRes) {
      state.analyticsError = "Failed to load usage data";
    }
  } catch (err) {
    state.analyticsError = err instanceof Error ? err.message : "Failed to load usage data";
  } finally {
    state.analyticsLoading = false;
  }
}
