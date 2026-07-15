import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "../../lib/sessions/index.ts";
import type { ProviderUsageSummary } from "./data-types.ts";

type RequestUsageSnapshotParams = {
  client: GatewayBrowserClient;
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  timeZone: "local" | "utc";
  agentId?: string;
  providerUsage: ProviderUsageSummary | null;
  refreshProviderUsage: boolean;
};

export async function requestUsageSnapshot(params: RequestUsageSnapshotParams): Promise<{
  result: SessionsUsageResult;
  costSummary: CostUsageSummary;
  providerUsage: ProviderUsageSummary | null;
}> {
  const agentScopeParams = params.agentId
    ? { agentId: params.agentId }
    : { agentScope: "all" as const };
  const providerUsageRequest = params.refreshProviderUsage
    ? params.client.request<ProviderUsageSummary>("usage.status").catch(() => null)
    : Promise.resolve(params.providerUsage);
  const [result, costSummary, providerUsage] = await Promise.all([
    requestSessionUsage(params.client, params),
    params.client.request<CostUsageSummary>("usage.cost", {
      startDate: params.startDate,
      endDate: params.endDate,
      ...agentScopeParams,
      ...buildSessionUsageDateParams(params.timeZone),
    }),
    providerUsageRequest,
  ]);
  return { result, costSummary, providerUsage };
}
