import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";

type ClaudeOrganization = {
  uuid?: string;
  name?: string;
};

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
};

type BrowserControlClient = {
  listTabs(profile: string): Promise<Array<{ targetId: string; url: string }>>;
  evaluate(
    profile: string,
    targetId: string,
    fn: string,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>;
};

/**
 * Fetch Claude usage via browser relay.
 * Requires an attached Chrome tab on claude.ai.
 */
export async function fetchClaudeUsageViaBrowser(
  browserClient: BrowserControlClient,
): Promise<ProviderUsageSnapshot | null> {
  // Find a claude.ai tab in the chrome profile
  let tabs: Array<{ targetId: string; url: string }>;
  try {
    tabs = await browserClient.listTabs("chrome");
  } catch {
    return null;
  }

  const claudeTab = tabs.find((tab) => tab.url?.includes("claude.ai"));
  if (!claudeTab) {
    return null;
  }

  // Fetch organizations
  let orgs: ClaudeOrganization[];
  try {
    const orgResult = await browserClient.evaluate(
      "chrome",
      claudeTab.targetId,
      "async () => { const res = await fetch('https://claude.ai/api/organizations'); return await res.json(); }",
    );
    if (!orgResult.ok || !Array.isArray(orgResult.result)) {
      return null;
    }
    orgs = orgResult.result as ClaudeOrganization[];
  } catch {
    return null;
  }

  const orgId = orgs?.[0]?.uuid?.trim();
  if (!orgId) {
    return null;
  }

  // Fetch usage
  let usage: ClaudeUsageResponse;
  try {
    const usageResult = await browserClient.evaluate(
      "chrome",
      claudeTab.targetId,
      `async () => { const res = await fetch('https://claude.ai/api/organizations/${orgId}/usage'); return await res.json(); }`,
    );
    if (!usageResult.ok || !usageResult.result) {
      return null;
    }
    usage = usageResult.result as ClaudeUsageResponse;
  } catch {
    return null;
  }

  // Parse windows
  const windows: UsageWindow[] = [];

  if (usage.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(usage.five_hour.utilization),
      resetAt: usage.five_hour.resets_at
        ? new Date(usage.five_hour.resets_at).getTime()
        : undefined,
    });
  }

  if (usage.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(usage.seven_day.utilization),
      resetAt: usage.seven_day.resets_at
        ? new Date(usage.seven_day.resets_at).getTime()
        : undefined,
    });
  }

  const modelWindow = usage.seven_day_sonnet || usage.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: usage.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: clampPercent(modelWindow.utilization),
    });
  }

  if (windows.length === 0) {
    return null;
  }

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}
