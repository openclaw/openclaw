import type { UsageSummary as SharedProviderUsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { CostUsageSummary } from "../../../../src/infra/session-cost-usage.types.js";
import type { SessionUsageTimePoint as SharedSessionUsageTimePoint } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult as SharedSessionsUsageResult } from "../../../../src/shared/usage-types.js";

export type SessionsUsageEntry = SharedSessionsUsageResult["sessions"][number];
export type SessionsUsageTotals = SharedSessionsUsageResult["totals"];
export type SessionsUsageResult = SharedSessionsUsageResult;
export type ProviderUsageSummary = SharedProviderUsageSummary;

export type CostUsageDailyEntry = CostUsageSummary["daily"][number];

export type { CostUsageSummary } from "../../../../src/infra/session-cost-usage.types.js";

export type SessionUsageTimePoint = SharedSessionUsageTimePoint;
