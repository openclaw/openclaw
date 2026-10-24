// Shared test helpers for provider usage loaders.
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import type { ProviderAuth } from "./provider-usage.auth.js";
import type { UsageSummary } from "./provider-usage.types.js";

export const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

type ProviderUsageLoader = (params: {
  auth?: ProviderAuth[];
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => Promise<UsageSummary>;

export type ProviderUsageAuth<T extends ProviderUsageLoader> = NonNullable<
  NonNullable<Parameters<T>[0]>["auth"]
>[number];

export async function loadUsageWithAuth<T extends ProviderUsageLoader>(
  loadProviderUsageSummary: T,
  auth: ProviderUsageAuth<T>[],
  mockFetch: ReturnType<typeof createProviderUsageFetch>,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);
  return await loadProviderUsageSummary({
    auth,
    env: {},
    // Keep config minimal; bundled provider usage hooks own the provider-specific fetchers now.
    config: {} as OpenClawConfig,
  });
}
