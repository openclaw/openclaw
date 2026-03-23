import {
  BarChart3,
  RotateCcw,
  Search,
  Calendar,
  DollarSign,
  Hash,
  MessageSquare,
  Wrench,
  AlertTriangle,
  TrendingUp,
  Download,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data";
import { StatCard } from "@/components/ui/custom/status/stat-card";
import { useGateway } from "@/hooks/use-gateway";
import { useGatewayStore } from "@/store/gateway-store";
import { DailyUsageChart } from "./usage-daily-chart";
import { InsightsCards, exportUsageCsv } from "./usage-export";
import { ActivityHeatmap } from "./usage-heatmap";
import { SessionDetailPanel } from "./usage-session-detail";

/* ── Types (matching server response shapes) ─────────────────────── */

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};

type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: string;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionMessageCounts = {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
};

type SessionToolUsage = {
  totalCalls: number;
  uniqueTools: number;
  tools: Array<{ name: string; count: number }>;
};

type SessionModelUsage = {
  provider?: string;
  model?: string;
  count: number;
  totals: UsageTotals;
};

type SessionLatencyStats = {
  count: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
};

type DailyBreakdown = { date: string; tokens: number; cost: number };

type SessionCostSummary = UsageTotals & {
  firstActivity?: number;
  lastActivity?: number;
  durationMs?: number;
  activityDates?: string[];
  dailyBreakdown?: DailyBreakdown[];
  dailyMessageCounts?: Array<{
    date: string;
    total: number;
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    errors: number;
  }>;
  dailyLatency?: Array<{
    date: string;
    count: number;
    avgMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  }>;
  dailyModelUsage?: Array<{
    date: string;
    provider?: string;
    model?: string;
    tokens: number;
    cost: number;
    count: number;
  }>;
  messageCounts?: SessionMessageCounts;
  toolUsage?: SessionToolUsage;
  modelUsage?: SessionModelUsage[];
  latency?: SessionLatencyStats;
};

type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: SessionOrigin;
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  [k: string]: unknown;
};

type UsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: UsageTotals }>;
  byChannel: Array<{ channel: string; totals: UsageTotals }>;
  latency?: SessionLatencyStats;
  dailyLatency?: Array<{
    date: string;
    count: number;
    avgMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  }>;
  modelDaily?: Array<{
    date: string;
    provider?: string;
    model?: string;
    tokens: number;
    cost: number;
    count: number;
  }>;
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: UsageTotals;
  aggregates: UsageAggregates;
};

type CostDailyEntry = UsageTotals & { date: string };

type CostUsageResult = {
  totals: UsageTotals;
  daily: CostDailyEntry[];
};

type TimeSeriesPoint = {
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  cumulativeTokens: number;
  cumulativeCost: number;
};

type TimeSeriesResult = {
  points: TimeSeriesPoint[];
};

type SessionLogEntry = {
  timestamp: number;
  role: "user" | "assistant" | "tool" | "toolResult";
  content: string;
  tokens?: number;
  cost?: number;
  /** Tool name for tool/toolResult entries; shown as a badge in the log view. */
  toolName?: string;
};

type SessionSort = "tokens" | "cost" | "recent" | "messages" | "errors";
type ChartMode = "tokens" | "cost";

/* ── Helpers ──────────────────────────────────────────────────────── */

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatCost(cost: number): string {
  if (cost === 0) {
    return "$0.00";
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/* ── Page Component ───────────────────────────────────────────────── */

export function UsagePage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // Date range
  const [startDate, setStartDate] = useState(() => daysAgoStr(29));
  const [endDate, setEndDate] = useState(() => todayStr());

  // Data
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionUsageEntry[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [aggregates, setAggregates] = useState<UsageAggregates | null>(null);
  const [costDaily, setCostDaily] = useState<CostDailyEntry[]>([]);

  // Session detail
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesResult | null>(null);
  const [timeSeriesLoading, setTimeSeriesLoading] = useState(false);
  const [sessionLogs, setSessionLogs] = useState<SessionLogEntry[] | null>(null);
  const [sessionLogsLoading, setSessionLogsLoading] = useState(false);

  // Filters & controls
  const [query, setQuery] = useState("");
  const [chartMode, setChartMode] = useState<ChartMode>("tokens");
  const [sessionSort, setSessionSort] = useState<SessionSort>("recent");
  const [sessionSortDir, setSessionSortDir] = useState<"asc" | "desc">("desc");

  // Load main usage data
  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usageResult, costResult] = await Promise.all([
        sendRpc<SessionsUsageResult>("sessions.usage", {
          startDate,
          endDate,
          limit: 1000,
        }),
        sendRpc<CostUsageResult>("usage.cost", {
          startDate,
          endDate,
        }),
      ]);
      setSessions(usageResult?.sessions ?? []);
      setTotals(usageResult?.totals ?? null);
      setAggregates(usageResult?.aggregates ?? null);
      setCostDaily(costResult?.daily ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sendRpc, startDate, endDate]);

  // Load session time series
  const loadTimeSeries = useCallback(
    async (key: string) => {
      setTimeSeriesLoading(true);
      try {
        const result = await sendRpc<TimeSeriesResult>("sessions.usage.timeseries", { key });
        setTimeSeries(result ?? null);
      } catch {
        setTimeSeries(null);
      } finally {
        setTimeSeriesLoading(false);
      }
    },
    [sendRpc],
  );

  // Load session logs
  const loadSessionLogs = useCallback(
    async (key: string) => {
      setSessionLogsLoading(true);
      try {
        const result = await sendRpc<{ logs: SessionLogEntry[] }>("sessions.usage.logs", {
          key,
          limit: 200,
        });
        setSessionLogs(result?.logs ?? null);
      } catch {
        setSessionLogs(null);
      } finally {
        setSessionLogsLoading(false);
      }
    },
    [sendRpc],
  );

  // Select a session for detail view
  const handleSelectSession = useCallback(
    (key: string) => {
      if (selectedSession === key) {
        setSelectedSession(null);
        setTimeSeries(null);
        setSessionLogs(null);
        return;
      }
      setSelectedSession(key);
      void loadTimeSeries(key);
      void loadSessionLogs(key);
    },
    [selectedSession, loadTimeSeries, loadSessionLogs],
  );

  // Auto-load on connect
  useEffect(() => {
    if (isConnected) {
      void loadUsage();
    }
  }, [isConnected, loadUsage]);

  // Date range presets
  const setDatePreset = useCallback((days: number) => {
    setStartDate(daysAgoStr(days - 1));
    setEndDate(todayStr());
  }, []);

  // Filter sessions by query
  const filteredSessions = useMemo(() => {
    let list = sessions;
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (s) =>
          s.key.toLowerCase().includes(q) ||
          s.label?.toLowerCase().includes(q) ||
          s.agentId?.toLowerCase().includes(q) ||
          s.channel?.toLowerCase().includes(q) ||
          s.model?.toLowerCase().includes(q),
      );
    }
    list = [...list].slice().toSorted((a, b) => {
      let cmp = 0;
      switch (sessionSort) {
        case "recent":
          cmp = (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
          break;
        case "tokens":
          cmp = (a.usage?.totalTokens ?? 0) - (b.usage?.totalTokens ?? 0);
          break;
        case "cost":
          cmp = (a.usage?.totalCost ?? 0) - (b.usage?.totalCost ?? 0);
          break;
        case "messages":
          cmp = (a.usage?.messageCounts?.total ?? 0) - (b.usage?.messageCounts?.total ?? 0);
          break;
        case "errors":
          cmp = (a.usage?.messageCounts?.errors ?? 0) - (b.usage?.messageCounts?.errors ?? 0);
          break;
      }
      return sessionSortDir === "desc" ? -cmp : cmp;
    });
    return list;
  }, [sessions, query, sessionSort, sessionSortDir]);

  // Find selected session entry for detail panel
  const selectedSessionEntry = useMemo(
    () => (selectedSession ? sessions.find((s) => s.key === selectedSession) : undefined),
    [selectedSession, sessions],
  );

  // Session table columns
  const sessionColumns: Column<SessionUsageEntry>[] = useMemo(
    () => [
      {
        key: "key",
        header: "Session",
        sortable: true,
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-xs text-primary truncate max-w-48">
              {row.label || row.key}
            </span>
            {row.label && (
              <span className="text-[10px] text-muted-foreground font-mono truncate max-w-48">
                {row.key}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "channel",
        header: "Channel",
        className: "w-20",
        render: (row) => (
          <span className="text-xs text-muted-foreground">{row.channel ?? "—"}</span>
        ),
      },
      {
        key: "agentId",
        header: "Agent",
        className: "w-20",
        render: (row) => (
          <span className="text-xs text-muted-foreground font-mono">{row.agentId ?? "—"}</span>
        ),
      },
      {
        key: "model",
        header: "Model",
        className: "w-28",
        render: (row) => (
          <span className="text-xs text-muted-foreground font-mono truncate max-w-28">
            {row.model ?? "—"}
          </span>
        ),
      },
      {
        key: "messages",
        header: "Msgs",
        className: "w-14",
        render: (row) => (
          <span className="text-xs font-mono text-muted-foreground">
            {row.usage?.messageCounts?.total ?? "—"}
          </span>
        ),
      },
      {
        key: "totalTokens",
        header: "Tokens",
        className: "w-20",
        sortable: true,
        render: (row) => (
          <span className="text-xs font-mono text-muted-foreground">
            {row.usage ? formatTokens(row.usage.totalTokens) : "—"}
          </span>
        ),
      },
      {
        key: "totalCost",
        header: "Cost",
        className: "w-16",
        sortable: true,
        render: (row) => (
          <span className="text-xs font-mono text-muted-foreground">
            {row.usage ? formatCost(row.usage.totalCost) : "—"}
          </span>
        ),
      },
      {
        key: "updatedAt",
        header: "Updated",
        className: "w-20",
        sortable: true,
        render: (row) => (
          <span className="text-xs text-muted-foreground">
            {row.updatedAt ? formatRelativeTime(row.updatedAt) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  // Not connected state
  if (!isConnected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-mono font-semibold">Usage</h1>
        </div>
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          <BarChart3 className="h-8 w-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Connect to the gateway to view usage data</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-mono font-semibold">Usage</h1>
          {sessions.length > 0 && (
            <span className="text-xs font-mono text-muted-foreground">
              {sessions.length} sessions
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sessions.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportUsageCsv({ sessions, startDate, endDate })}
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={loadUsage} disabled={loading}>
            <RotateCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Date Range Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs font-mono outline-none focus-visible:border-ring"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs font-mono outline-none focus-visible:border-ring"
          />
        </div>
        <div className="flex items-center gap-1">
          {[
            { label: "Today", days: 1 },
            { label: "7d", days: 7 },
            { label: "30d", days: 30 },
            { label: "90d", days: 90 },
          ].map((preset) => (
            <Button
              key={preset.days}
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDatePreset(preset.days)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={loadUsage}
          disabled={loading}
        >
          Apply
        </Button>

        {/* Chart mode toggle */}
        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant={chartMode === "tokens" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setChartMode("tokens")}
          >
            <Hash className="h-3 w-3 mr-1" />
            Tokens
          </Button>
          <Button
            variant={chartMode === "cost" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setChartMode("cost")}
          >
            <DollarSign className="h-3 w-3 mr-1" />
            Cost
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-destructive/70 hover:text-destructive text-xs ml-2"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Summary Cards */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard
            icon={<Hash className="h-4 w-4" />}
            label="Total Tokens"
            value={formatTokens(totals.totalTokens)}
            subtitle={`${formatTokens(totals.input)} in / ${formatTokens(totals.output)} out`}
          />
          <StatCard
            icon={<DollarSign className="h-4 w-4" />}
            label="Total Cost"
            value={formatCost(totals.totalCost)}
            subtitle={
              totals.missingCostEntries > 0 ? `${totals.missingCostEntries} missing` : undefined
            }
          />
          <StatCard
            icon={<MessageSquare className="h-4 w-4" />}
            label="Messages"
            value={String(aggregates?.messages.total ?? 0)}
            subtitle={
              aggregates
                ? `${aggregates.messages.user} user / ${aggregates.messages.assistant} assistant`
                : undefined
            }
          />
          <StatCard
            icon={<Wrench className="h-4 w-4" />}
            label="Tool Calls"
            value={String(aggregates?.tools.totalCalls ?? 0)}
            subtitle={aggregates ? `${aggregates.tools.uniqueTools} unique tools` : undefined}
          />
          <StatCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Errors"
            value={String(aggregates?.messages.errors ?? 0)}
          />
        </div>
      )}

      {/* Daily Usage Chart */}
      {aggregates && aggregates.daily.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-mono font-semibold">Daily Usage</h2>
            <span className="text-[10px] text-muted-foreground">
              {aggregates.daily.length} days
            </span>
          </div>
          <DailyUsageChart data={aggregates.daily} costDaily={costDaily} mode={chartMode} />
        </div>
      )}

      {/* Activity Heatmap */}
      {aggregates && aggregates.daily.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-mono font-semibold mb-3">Activity</h2>
          <ActivityHeatmap data={aggregates.daily} mode={chartMode} />
        </div>
      )}

      {/* Insights Cards */}
      {aggregates && <InsightsCards aggregates={aggregates} mode={chartMode} />}

      {/* Breakdown Cards */}
      {aggregates && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {aggregates.byModel.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-mono font-semibold mb-2 text-muted-foreground">
                By Model
              </h3>
              <div className="space-y-1.5">
                {aggregates.byModel.slice(0, 8).map((m) => (
                  <div
                    key={`${m.provider}-${m.model}`}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="font-mono truncate max-w-40">
                      {m.model ?? "unknown"}
                      <span className="text-muted-foreground ml-1">({m.provider})</span>
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {chartMode === "cost"
                        ? formatCost(m.totals.totalCost)
                        : formatTokens(m.totals.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {aggregates.byChannel.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-mono font-semibold mb-2 text-muted-foreground">
                By Channel
              </h3>
              <div className="space-y-1.5">
                {aggregates.byChannel.map((c) => (
                  <div key={c.channel} className="flex items-center justify-between text-xs">
                    <span className="font-mono">{c.channel}</span>
                    <span className="font-mono text-muted-foreground">
                      {chartMode === "cost"
                        ? formatCost(c.totals.totalCost)
                        : formatTokens(c.totals.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sessions List */}
      <div>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search sessions..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-56 rounded-md border border-input bg-transparent pl-9 pr-3 text-sm outline-none focus-visible:border-ring placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">Sort:</span>
            {(["recent", "tokens", "cost", "messages", "errors"] as SessionSort[]).map((s) => (
              <Button
                key={s}
                variant={sessionSort === s ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs capitalize"
                onClick={() => {
                  if (sessionSort === s) {
                    setSessionSortDir((d) => (d === "desc" ? "asc" : "desc"));
                  } else {
                    setSessionSort(s);
                    setSessionSortDir("desc");
                  }
                }}
              >
                {s}
                {sessionSort === s && (
                  <span className="ml-0.5 text-[10px]">
                    {sessionSortDir === "desc" ? "\u2193" : "\u2191"}
                  </span>
                )}
              </Button>
            ))}
          </div>
        </div>

        <div className={loading ? "opacity-60 pointer-events-none" : ""}>
          <DataTable
            columns={sessionColumns}
            data={filteredSessions}
            keyField="key"
            emptyMessage={query ? "No matching sessions" : "No usage data for this period"}
            onRowClick={(row) => handleSelectSession(row.key)}
            compact
          />
        </div>
      </div>

      {/* Session Detail Panel */}
      {selectedSession && selectedSessionEntry && (
        <div className="rounded-lg border border-border bg-card p-4">
          <SessionDetailPanel
            sessionKey={selectedSession}
            session={selectedSessionEntry}
            timeSeries={timeSeries}
            timeSeriesLoading={timeSeriesLoading}
            sessionLogs={sessionLogs}
            sessionLogsLoading={sessionLogsLoading}
            onClose={() => {
              setSelectedSession(null);
              setTimeSeries(null);
              setSessionLogs(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
