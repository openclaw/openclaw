import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";

type UsageSnapshotValue = {
  result: Awaited<ReturnType<typeof requestSessionUsage>>;
  costSummary: CostUsageSummary;
  providerUsage: ProviderUsageSnapshot;
};

type UsageSnapshotFailure = {
  cause: unknown;
  providerUsage: ProviderUsageSnapshot;
};

export type ProviderUsageSnapshot =
  | { state: "pending" }
  | { state: "settled"; result: ProviderUsageRequestResult };

export type UsageSnapshotResult = Result<UsageSnapshotValue, UsageSnapshotFailure>;

export function providerUsageFromSnapshotResult(
  result: UsageSnapshotResult,
): ProviderUsageSnapshot {
  return result.ok ? result.value.providerUsage : result.error.providerUsage;
}

export async function requestUsageSnapshot(
  client: GatewayBrowserClient,
  query: SessionUsageQuery,
  signal?: AbortSignal,
): Promise<UsageSnapshotResult> {
  let settledProviderUsage: ProviderUsageSnapshot | undefined;
  const providerUsagePromise = requestProviderUsage(client, signal ? { signal } : undefined).then(
    (result): ProviderUsageSnapshot => (settledProviderUsage = { state: "settled", result }),
  );
  try {
    const [result, providerUsage] = await Promise.all([
      requestSessionUsage(client, query, { signal }),
      providerUsagePromise,
    ]);
    const costSummary: CostUsageSummary = {
      updatedAt: result.updatedAt,
      days: (Date.parse(result.endDate) - Date.parse(result.startDate)) / 86_400_000 + 1,
      daily: result.aggregates.costDaily ?? [],
      totals: result.totals,
      cacheStatus: result.cacheStatus,
    };
    return ok({ result, costSummary, providerUsage });
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    return err({ cause, providerUsage: settledProviderUsage ?? { state: "pending" } });
  }
}
