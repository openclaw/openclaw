import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";

type UsageSnapshotValue = {
  result: Awaited<ReturnType<typeof requestSessionUsage>>;
  costSummary: CostUsageSummary;
};

/** Provider plans load separately: session usage never waits on provider APIs. */
type UsageSnapshotResult = Result<UsageSnapshotValue, { cause: unknown }>;

export async function requestUsageSnapshot(
  client: GatewayBrowserClient,
  query: SessionUsageQuery,
  signal?: AbortSignal,
): Promise<UsageSnapshotResult> {
  try {
    const result = await requestSessionUsage(client, query, { projection: "overview", signal });
    const costSummary: CostUsageSummary = {
      updatedAt: result.updatedAt,
      days: (Date.parse(result.endDate) - Date.parse(result.startDate)) / 86_400_000 + 1,
      daily: result.aggregates.costDaily ?? [],
      totals: result.totals,
      cacheStatus: result.cacheStatus,
    };
    return ok({ result, costSummary });
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    return err({ cause });
  }
}
