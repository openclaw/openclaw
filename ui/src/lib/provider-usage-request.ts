// A successful empty usage.status response is valid data, distinct from failure.
// Cancellation still propagates so consumers can discard superseded work.
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

export type ProviderUsageRequestResult = { ok: true; value: UsageSummary } | { ok: false };

export async function requestProviderUsage(
  client: GatewayBrowserClient,
  opts?: { signal?: AbortSignal },
): Promise<ProviderUsageRequestResult> {
  try {
    const summary = await client.request<UsageSummary>("usage.status", undefined, opts);
    return { ok: true, value: summary };
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw error;
    }
    return { ok: false };
  }
}
