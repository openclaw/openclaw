import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionMessageCounts,
  SessionModelUsage,
  SessionToolUsage,
} from "../infra/session-cost-usage.types.js";

export type SessionCostUsagePublication = {
  agentId: string;
  usageUpdatedAt: number;
  usageRefreshFailed?: true;
};

export type SessionUsageCreator = {
  /** Opaque, namespace-qualified identity used by the creator filter. */
  key: string;
  actor?: SessionCreatedActor;
};

export type SessionUsageEntry = {
  /** Stable row key for UI diffing; may be a session id or family key. */
  key: string;
  label?: string;
  /** Concrete session id for instance-scoped rows. */
  sessionId?: string;
  scope?: "instance" | "family";
  /** Grouping key shared by related historical session instances. */
  sessionFamilyKey?: string;
  /** Latest/current session id for a grouped family row. */
  currentSessionId?: string;
  includedSessionIds?: string[];
  historicalInstanceCount?: number;
  updatedAt?: number;
  agentId?: string;
  /** Immutable session creator; this is not per-turn billing attribution. */
  createdActor?: SessionCreatedActor;
  creatorKey?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  computing?: boolean;
  /** Context availability without transferring the full report in overview queries. */
  hasContextWeight?: boolean;
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageAggregates = {
  /** Sessions with activity in the requested range, before the row `limit` cap. */
  sessionCount?: number;
  /** Longest single-row duration across every matched session, not just returned rows. */
  longestSessionDurationMs?: number;
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  byCreator?: Array<
    SessionUsageCreator & {
      totals: CostUsageSummary["totals"];
      sessionCount: number;
      daily: CostUsageSummary["daily"];
      /** Date-set cohorts count each session once across any selected days, without exposing IDs. */
      sessionActivity: Array<{ dates: string[]; sessionCount: number }>;
    }
  >;
  /** Full token/cost categories before the row limit. Overview keeps this calendar facet before selectedDays. */
  costDaily?: CostUsageSummary["daily"];
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  /** Unix epoch milliseconds for when this report was generated. */
  updatedAt: number;
  /** Inclusive report start date in YYYY-MM-DD form. */
  startDate: string;
  /** Inclusive report end date in YYYY-MM-DD form. */
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
  aggregates: SessionsUsageAggregates;
  /** Visible candidate identities before applying the creator filter. */
  creatorOptions?: SessionUsageCreator[];
  cacheStatus?: CostUsageSummary["cacheStatus"];
  overview?: SessionsUsageOverview;
};

export type UsageOverviewOptions = {
  limit?: number;
  offset?: number;
  query?: string;
  selectedDays?: string[];
  selectedHours?: number[];
  selectedSessions?: string[];
  recentKeys?: string[];
  sort?: "recent" | "tokens" | "cost" | "messages" | "errors";
  sortDirection?: "asc" | "desc";
};

export type SessionsUsageOverview = {
  total: number;
  unfilteredSessionCount: number;
  /** Sessions with activity in the selected population; empty comparison rows do not count. */
  selectedSessionCount: number;
  /** Matching rows in the selected population, including empty sessions eligible for detail reads. */
  selectedRowCount: number;
  /** Comparison statistics before paging and the Recent roster selection. */
  tableSessionCount: number;
  tableTotals: { tokens: number; cost: number; errors: number };
  offset: number;
  limit: number;
  queryWarnings: string[];
  hourTokens: number[];
  weekdayTokens: number[];
  hasTimelineData: boolean;
  durationMs: number;
  durationCount: number;
  hourlyMessages: number[];
  hourlyErrors: number[];
  filterOptions: Record<"agent" | "channel" | "provider" | "model" | "tool", string[]>;
};

/** Already-authorized metadata; the worker supplies usage from the owning store. */
export type UsageOverviewSession = Omit<SessionUsageEntry, "usage" | "contextWeight"> & {
  agentId: string;
  instances: Array<{ sessionId?: string; sessionFile: string }>;
};

/** Aggregated report with one final, bounded comparison page. */
export type UsageOverviewSlice = Pick<SessionsUsageResult, "sessions" | "totals" | "aggregates"> & {
  overview: SessionsUsageOverview;
};
