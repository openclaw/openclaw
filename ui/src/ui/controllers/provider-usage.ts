import type { GatewayBrowserClient } from "../gateway";
import type { ProviderUsageSnapshot, UsageSummary } from "../types";

export type ClaudeSharedUsage = {
  fiveHourPercent: number;
  fiveHourResetAt?: number;
  sevenDayPercent: number;
  sevenDayResetAt?: number;
  fetchedAt: number;
};

export type ProviderUsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  providerUsage: UsageSummary | null;
  providerUsageLoading: boolean;
  providerUsageError: string | null;
  // Claude shared usage (from browser refresh)
  claudeSharedUsage: ClaudeSharedUsage | null;
  claudeRefreshLoading: boolean;
  claudeRefreshError: string | null;
};

type BrowserTabsResponse = {
  tabs?: Array<{ targetId: string; url: string }>;
};

type BrowserActResponse = {
  ok?: boolean;
  result?: unknown;
};

/**
 * Try to fetch Claude usage via browser relay (Chrome extension).
 * Returns a provider snapshot if successful, null otherwise.
 */
async function tryClaudeBrowserFetch(
  client: GatewayBrowserClient,
): Promise<ProviderUsageSnapshot | null> {
  try {
    // List chrome tabs
    const tabsRes = await client.request<BrowserTabsResponse>("browser.request", {
      method: "GET",
      path: "/tabs",
      query: { profile: "chrome" },
    });

    const tabs = tabsRes?.tabs ?? [];
    const claudeTab = tabs.find((t) => t.url?.includes("claude.ai"));
    if (!claudeTab) return null;

    // Fetch organizations via /act endpoint
    const orgRes = await client.request<BrowserActResponse>("browser.request", {
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: {
        targetId: claudeTab.targetId,
        kind: "evaluate",
        fn: "async () => { const res = await fetch('https://claude.ai/api/organizations'); return await res.json(); }",
      },
    });

    if (!orgRes?.ok || !Array.isArray(orgRes.result)) return null;
    const orgs = orgRes.result as Array<{ uuid?: string }>;
    const orgId = orgs?.[0]?.uuid?.trim();
    if (!orgId) return null;

    // Fetch usage via /act endpoint
    const usageRes = await client.request<BrowserActResponse>("browser.request", {
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: {
        targetId: claudeTab.targetId,
        kind: "evaluate",
        fn: `async () => { const res = await fetch('https://claude.ai/api/organizations/${orgId}/usage'); return await res.json(); }`,
      },
    });

    if (!usageRes?.ok || !usageRes.result) return null;
    const usage = usageRes.result as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
      seven_day_sonnet?: { utilization?: number };
      seven_day_opus?: { utilization?: number };
    };

    // Build windows
    const windows: Array<{ label: string; usedPercent: number; resetAt?: number }> = [];

    if (usage.five_hour?.utilization !== undefined) {
      windows.push({
        label: "5h",
        usedPercent: Math.min(100, Math.max(0, usage.five_hour.utilization)),
        resetAt: usage.five_hour.resets_at
          ? new Date(usage.five_hour.resets_at).getTime()
          : undefined,
      });
    }

    if (usage.seven_day?.utilization !== undefined) {
      windows.push({
        label: "Week",
        usedPercent: Math.min(100, Math.max(0, usage.seven_day.utilization)),
        resetAt: usage.seven_day.resets_at
          ? new Date(usage.seven_day.resets_at).getTime()
          : undefined,
      });
    }

    const modelWindow = usage.seven_day_sonnet || usage.seven_day_opus;
    if (modelWindow?.utilization !== undefined) {
      windows.push({
        label: usage.seven_day_sonnet ? "Sonnet" : "Opus",
        usedPercent: Math.min(100, Math.max(0, modelWindow.utilization)),
      });
    }

    if (windows.length === 0) return null;

    return {
      provider: "anthropic",
      displayName: "Claude",
      windows,
    };
  } catch {
    return null;
  }
}

export async function loadProviderUsage(state: ProviderUsageState) {
  if (!state.client || !state.connected) return;
  if (state.providerUsageLoading) return;
  state.providerUsageLoading = true;
  state.providerUsageError = null;
  try {
    const result = await state.client.request<UsageSummary>("usage.status", {});

    // Check if Anthropic failed and try browser fallback
    const anthropicIdx = result.providers.findIndex((p) => p.provider === "anthropic");
    if (anthropicIdx >= 0 && result.providers[anthropicIdx]?.error) {
      const browserUsage = await tryClaudeBrowserFetch(state.client);
      if (browserUsage) {
        result.providers[anthropicIdx] = browserUsage;
      } else {
        // If browser fallback also failed and we have internal token tracking,
        // remove the errored provider entry (internal tracking will show instead)
        const hasInternalTracking = result.tokenUsage?.some(
          (t) => t.provider === "anthropic" && (t.today.requestCount > 0 || t.fiveHour.requestCount > 0)
        );
        if (hasInternalTracking) {
          // Remove the errored provider - internal tracking is sufficient
          result.providers.splice(anthropicIdx, 1);
        }
      }
    }

    // Filter out providers with errors when we have no useful data from them
    // Keep the error only if there's no internal tracking alternative
    result.providers = result.providers.filter((p) => {
      if (!p.error) return true;
      if (p.windows.length > 0) return true;
      // Check if we have internal tracking for this provider
      const hasInternal = result.tokenUsage?.some((t) => t.provider === p.provider);
      return !hasInternal; // Only show error if no internal tracking
    });

    state.providerUsage = result;
  } catch (err) {
    // Even on total failure, try to show empty state rather than error
    // The internal tracking might still work
    state.providerUsageError = err instanceof Error ? err.message : String(err);
  } finally {
    state.providerUsageLoading = false;
  }
}

/**
 * Refresh Claude shared usage via browser relay.
 * Requires a Chrome tab with claude.ai open.
 */
export async function refreshClaudeSharedUsage(state: ProviderUsageState): Promise<void> {
  if (!state.client || !state.connected) {
    state.claudeRefreshError = "Not connected to gateway";
    return;
  }
  if (state.claudeRefreshLoading) return;
  
  state.claudeRefreshLoading = true;
  state.claudeRefreshError = null;
  
  try {
    // Check if Chrome relay is available
    const tabsRes = await state.client.request<BrowserTabsResponse>("browser.request", {
      method: "GET",
      path: "/tabs",
      query: { profile: "chrome" },
    });

    const tabs = tabsRes?.tabs ?? [];
    const claudeTab = tabs.find((t) => t.url?.includes("claude.ai"));
    
    if (!claudeTab) {
      state.claudeRefreshError = "Open claude.ai in Chrome and click the OpenClaw extension icon to connect";
      return;
    }

    // Fetch organizations
    const orgRes = await state.client.request<BrowserActResponse>("browser.request", {
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: {
        targetId: claudeTab.targetId,
        kind: "evaluate",
        fn: "async () => { const res = await fetch('https://claude.ai/api/organizations'); return await res.json(); }",
      },
    });

    if (!orgRes?.ok || !Array.isArray(orgRes.result)) {
      state.claudeRefreshError = "Failed to fetch organizations from Claude";
      return;
    }
    
    // Find the subscription org (has claude_max capability)
    const orgs = orgRes.result as Array<{ uuid?: string; capabilities?: string[] }>;
    const subscriptionOrg = orgs.find((o) => o.capabilities?.includes("claude_max")) ?? orgs[0];
    const orgId = subscriptionOrg?.uuid?.trim();
    
    if (!orgId) {
      state.claudeRefreshError = "No Claude organization found";
      return;
    }

    // Fetch usage
    const usageRes = await state.client.request<BrowserActResponse>("browser.request", {
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: {
        targetId: claudeTab.targetId,
        kind: "evaluate",
        fn: `async () => { const res = await fetch('https://claude.ai/api/organizations/${orgId}/usage'); return await res.json(); }`,
      },
    });

    if (!usageRes?.ok || !usageRes.result) {
      state.claudeRefreshError = "Failed to fetch usage from Claude";
      return;
    }
    
    const usage = usageRes.result as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
    };

    // Store the shared usage
    state.claudeSharedUsage = {
      fiveHourPercent: usage.five_hour?.utilization ?? 0,
      fiveHourResetAt: usage.five_hour?.resets_at 
        ? new Date(usage.five_hour.resets_at).getTime() 
        : undefined,
      sevenDayPercent: usage.seven_day?.utilization ?? 0,
      sevenDayResetAt: usage.seven_day?.resets_at 
        ? new Date(usage.seven_day.resets_at).getTime() 
        : undefined,
      fetchedAt: Date.now(),
    };
    
  } catch (err) {
    state.claudeRefreshError = err instanceof Error ? err.message : String(err);
  } finally {
    state.claudeRefreshLoading = false;
  }
}
