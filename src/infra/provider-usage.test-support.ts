import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import type { ProviderAuth } from "./provider-usage.auth.js";
import type { UsageSummary } from "./provider-usage.types.js";

export const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

type ProviderUsageLoader = (params: {
  now: number;
  auth?: ProviderAuth[];
  fetch?: typeof fetch;
}) => Promise<UsageSummary>;

export type ProviderUsageAuth = ProviderAuth;

export async function loadUsageWithAuth(
  loadProviderUsageSummary: ProviderUsageLoader,
  auth: ProviderUsageAuth[],
  mockFetch: ReturnType<typeof createProviderUsageFetch>,
): Promise<UsageSummary> {
  return await loadProviderUsageSummary({
    now: usageNow,
    auth,
    fetch: mockFetch as unknown as typeof fetch,
  });
}
