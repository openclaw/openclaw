import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ProviderUsageSummary } from "./data-types.ts";

export type UsageRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  query: {
    startDate: string;
    endDate: string;
    scope: "instance" | "family";
    timeZone: "local" | "utc";
    agentId: string | null;
  };
  result: SessionsUsageResult | null;
  costSummary: CostUsageSummary | null;
  providerUsageSummary: ProviderUsageSummary | null;
  error: string | null;
};
