import type { SessionLogEntry } from "../../../../src/infra/session-cost-usage.types.js";
import type { CostUsageSummary } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status-state.ts";
import type { PageReadResult } from "../../lib/page-request.ts";
import type {
  CostUsageDailyEntry,
  SessionsUsageEntry,
  SessionsUsageResult,
  SessionsUsageTotals,
} from "./data-types.ts";

export type UsageSessionEntry = SessionsUsageEntry;
export type UsageTotals = SessionsUsageTotals;
export type CostDailyEntry = CostUsageDailyEntry;
export type UsageAggregates = SessionsUsageResult["aggregates"];

export type UsageContextDetail = {
  weight: UsageSessionEntry["contextWeight"];
  loading: boolean;
  read: Promise<PageReadResult> | null;
  status: PanelRefreshStatus;
};

export type UsageJsonExport = {
  totals: UsageTotals | null;
  sessions: UsageSessionEntry[];
  daily: CostDailyEntry[];
  aggregates: UsageAggregates;
};

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
    creatorKey?: string;
  };
  result: SessionsUsageResult | null;
  costSummary: CostUsageSummary | null;
  loadedAtMs: number | null;
  error: string | null;
};

export type UsageFilterState = {
  startDate: string;
  endDate: string;
  scope: "instance" | "family";
  selectedSessions: string[];
  selectedDays: string[];
  selectedHours: number[];
  creatorKey: string | null;
  query: string;
  queryDraft: string;
  timeZone: "local" | "utc";
};

export type UsageDisplayState = {
  chartMode: "tokens" | "cost";
  dailyChartMode: "total" | "by-type" | "by-provider";
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  sessionSortDir: "asc" | "desc";
  recentSessions: string[];
  sessionsTab: "all" | "recent";
  contextExpanded: boolean;
  headerPinned: boolean;
};

export type UsageDetailPresentation = {
  timeSeriesMode: "cumulative" | "per-turn";
  timeSeriesBreakdownMode: "total" | "by-type";
  timeSeriesCursorStart: number | null; // Start of selected range (null = no selection)
  timeSeriesCursorEnd: number | null; // End of selected range (null = no selection)
  sessionLogsExpanded: boolean;
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  };
};

export type { SessionLogEntry } from "../../../../src/infra/session-cost-usage.types.js";

export type SessionLogRole = SessionLogEntry["role"];

export type UsagePresentation = {
  display: Pick<
    UsageDisplayState,
    "chartMode" | "dailyChartMode" | "contextExpanded" | "headerPinned"
  >;
  detail: UsageDetailPresentation;
};
