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
} from "../infra/session-cost-usage.js";

export type SessionUsageEntry = {
  /** Stable row key used by API consumers for session or family entries. */
  key: string;
  /** Human-readable session label for UI display. */
  label?: string;
  /** Concrete session id represented by this entry when scope is instance-level. */
  sessionId?: string;
  /** Whether the entry describes one session instance or an aggregated family. */
  scope?: "instance" | "family";
  /** Stable family key that groups historical session instances. */
  sessionFamilyKey?: string;
  /** Current live session id for family-scoped entries. */
  currentSessionId?: string;
  /** Session ids included in a family aggregate. */
  includedSessionIds?: string[];
  /** Number of historical instances rolled into the entry. */
  historicalInstanceCount?: number;
  /** Latest usage update timestamp among included sessions. */
  updatedAt?: number;
  /** Agent id that owns the usage, when known. */
  agentId?: string;
  /** Channel id or transport family associated with the session. */
  channel?: string;
  /** Conversation shape used for grouping and UI filters. */
  chatType?: string;
  /** Original conversation/source metadata used for usage attribution. */
  origin?: {
    /** Display label for the source conversation. */
    label?: string;
    /** Origin provider such as a channel or integration. */
    provider?: string;
    /** Source surface within the provider. */
    surface?: string;
    /** Conversation shape reported by the origin. */
    chatType?: string;
    /** Source sender identifier, when available. */
    from?: string;
    /** Source recipient or target identifier, when available. */
    to?: string;
    /** Channel account id associated with the origin. */
    accountId?: string;
    /** Provider thread id associated with the origin. */
    threadId?: string | number;
  };
  /** Explicit model override configured for the session. */
  modelOverride?: string;
  /** Explicit provider override configured for the session. */
  providerOverride?: string;
  /** Resolved provider id that produced usage. */
  modelProvider?: string;
  /** Resolved model id that produced usage. */
  model?: string;
  /** Cost/token/tool/message usage summary, or null when unavailable. */
  usage: SessionCostSummary | null;
  /** System-prompt/context weight report associated with the session. */
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageAggregates = {
  /** Message counts summed across returned sessions. */
  messages: SessionMessageCounts;
  /** Tool call counts summed across returned sessions. */
  tools: SessionToolUsage;
  /** Usage totals grouped by model. */
  byModel: SessionModelUsage[];
  /** Usage totals grouped by provider. */
  byProvider: SessionModelUsage[];
  /** Usage totals grouped by agent id. */
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  /** Usage totals grouped by channel id. */
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  /** Latency summary across counted requests. */
  latency?: SessionLatencyStats;
  /** Daily latency summaries sorted by date. */
  dailyLatency?: SessionDailyLatency[];
  /** Daily model usage summaries sorted by date and cost. */
  modelDaily?: SessionDailyModelUsage[];
  /** Daily aggregate usage summaries sorted by date. */
  daily: Array<{
    /** ISO calendar date for the aggregate bucket. */
    date: string;
    /** Total tokens used on the date. */
    tokens: number;
    /** Total estimated cost on the date. */
    cost: number;
    /** Total messages on the date. */
    messages: number;
    /** Total tool calls on the date. */
    toolCalls: number;
    /** Total errors on the date. */
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  /** Response generation timestamp. */
  updatedAt: number;
  /** Inclusive usage window start date. */
  startDate: string;
  /** Inclusive usage window end date. */
  endDate: string;
  /** Session or session-family entries included in this response. */
  sessions: SessionUsageEntry[];
  /** Totals across all returned entries. */
  totals: CostUsageSummary["totals"];
  /** Grouped aggregate summaries for charts and filters. */
  aggregates: SessionsUsageAggregates;
  /** Cache freshness metadata from the provider usage store. */
  cacheStatus?: CostUsageSummary["cacheStatus"];
};
