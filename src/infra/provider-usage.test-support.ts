import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

export const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

type ProviderUsageLoader = (params: {
  now: number;
  auth: Array<{ provider: string; token?: string; accountId?: string }>;
  fetch?: typeof fetch;
}) => Promise<unknown>;

export type ProviderUsageAuth<T extends ProviderUsageLoader> = NonNullable<
  NonNullable<Parameters<T>[0]>["auth"]
>[number];

export async function loadUsageWithAuth<T extends ProviderUsageLoader>(
  loadProviderUsageSummary: T,
  auth: ProviderUsageAuth<T>[],
  mockFetch: ReturnType<typeof createProviderUsageFetch>,
) {
  return await loadProviderUsageSummary({
    now: usageNow,
    auth,
    fetch: mockFetch as unknown as typeof fetch,
  });
}
