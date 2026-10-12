import { vi } from "vitest";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { UsageFilterOptions } from "./query.ts";
import type { UsageProps, UsageSessionEntry, UsageTotals, UsageAggregates } from "./types.ts";

const noop = vi.fn();

export function usageSession(
  key: string,
  agentId: string,
  provider: string,
  totalsOverrides: Partial<UsageTotals> = {},
): UsageSessionEntry {
  const totals: UsageTotals = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    totalCost: 1,
    inputCost: 0.8,
    outputCost: 0.2,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...totalsOverrides,
  };
  return {
    key,
    label: `${agentId} session`,
    agentId,
    modelProvider: provider,
    model: `${provider}-model`,
    updatedAt: Date.now(),
    usage: {
      ...totals,
      messageCounts: {
        total: 2,
        user: 1,
        assistant: 1,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      modelUsage: [{ provider, model: `${provider}-model`, count: 1, totals }],
    },
  };
}

export function createUsageProps(overrides: Partial<UsageProps> = {}): UsageProps {
  const props: UsageProps = {
    data: {
      loading: false,
      exporting: false,
      error: null,
      sessions: [],
      creatorOptions: [],
      totals: null,
      aggregates: null,
      costDaily: [],
      cacheRefresh: "complete",
      providerUsage: [],
      providerUsageStalled: false,
      providerUsageUnavailable: false,
    },
    filters: {
      startDate: "2026-05-14",
      endDate: "2026-05-14",
      scope: "family",
      selectedSessions: [],
      selectedDays: [],
      selectedHours: [],
      creatorKey: null,
      query: "",
      queryDraft: "",
      timeZone: "local",
    },
    display: {
      chartMode: "tokens",
      dailyChartMode: "total",
      sessionSort: "tokens",
      sessionSortDir: "desc",
      recentSessions: [],
      sessionsTab: "all",
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      context: {
        weight: undefined,
        loading: false,
        status: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      },
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      sessionLogsExpanded: false,
      logFilters: {
        roles: [],
        tools: [],
        hasTools: false,
        query: "",
      },
    },
    callbacks: {
      filters: {
        onDatesChange: noop,
        onScopeChange: noop,
        onRefresh: noop,
        onToggleHeaderPinned: noop,
        onSelectDay: noop,
        onSelectHour: noop,
        onClearDays: noop,
        onClearHours: noop,
        onClearSessions: noop,
        onClearFilters: noop,
        onQueryDraftChange: noop,
        onApplyQuery: noop,
        onClearQuery: noop,
      },
      display: {
        onExportJson: noop,
        onExportCsv: noop,
        onPageChange: noop,
        onChange: noop,
      },
      details: {
        onToggleContextExpanded: noop,
        onToggleSessionLogsExpanded: noop,
        onLogFiltersChange: noop,
        onSelectSession: noop,
        onTimeSeriesModeChange: noop,
        onTimeSeriesBreakdownChange: noop,
        onTimeSeriesCursorRangeChange: noop,
      },
    },
    ...overrides,
  };
  if (props.data.sessions.length && !props.data.overview) {
    props.data.overview = projectUsageData(props.data.sessions).overview;
  }
  return props;
}

export function createUsageOverview(
  overrides: Partial<NonNullable<UsageProps["data"]["overview"]>> = {},
): NonNullable<UsageProps["data"]["overview"]> {
  return {
    total: 0,
    unfilteredSessionCount: 0,
    selectedSessionCount: 0,
    selectedRowCount: 0,
    tableSessionCount: 0,
    tableTotals: { tokens: 0, cost: 0, errors: 0 },
    offset: 0,
    limit: 50,
    queryWarnings: [],
    hourTokens: Array(24).fill(0),
    weekdayTokens: Array(7).fill(0),
    hasTimelineData: false,
    durationMs: 0,
    durationCount: 0,
    hourlyMessages: Array(24).fill(0),
    hourlyErrors: Array(24).fill(0),
    filterOptions: { agent: [], channel: [], provider: [], model: [], tool: [] },
    ...overrides,
  };
}

export function projectUsageData(
  sessions: UsageSessionEntry[],
  filters: Partial<UsageProps["filters"]> = {},
): Pick<UsageProps["data"], "sessions" | "totals" | "aggregates" | "overview" | "costDaily"> {
  const result = buildUsageOverview({
    rows: sessions,
    options: {
      query: filters.query,
      selectedDays: filters.selectedDays,
      selectedHours: filters.selectedHours,
      selectedSessions: filters.selectedSessions,
    },
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
  });
  return { ...result, costDaily: result.aggregates.costDaily ?? [] };
}

export const buildAggregatesFromSessions = (
  sessions: UsageSessionEntry[],
  fallback?: UsageAggregates | null,
): UsageAggregates => {
  if (sessions.length === 0) {
    return (
      fallback ?? {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      }
    );
  }

  const accumulator = createUsageAggregateAccumulator();
  for (const session of sessions) {
    accumulator.add(session);
  }
  return accumulator.finish();
};

function appendFilterValues<T>(
  values: string[],
  entries: readonly T[],
  read: (entry: T) => string | undefined,
  limit = 12,
): void {
  for (const entry of entries) {
    if (values.length >= limit) {
      break;
    }
    const value = read(entry);
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }
}

export function buildUsageFilterOptions(
  sessions: readonly UsageSessionEntry[],
  aggregates?: UsageAggregates | null,
): UsageFilterOptions {
  const options: UsageFilterOptions = { agent: [], channel: [], provider: [], model: [], tool: [] };
  appendFilterValues(options.agent, sessions, (session) => session.agentId, 6);
  appendFilterValues(options.channel, sessions, (session) => session.channel);
  appendFilterValues(options.provider, sessions, (session) => session.modelProvider);
  // Overrides follow every observed provider, preserving the menu's first-seen order.
  appendFilterValues(options.provider, sessions, (session) => session.providerOverride);
  appendFilterValues(options.provider, aggregates?.byProvider ?? [], (entry) => entry.provider);
  appendFilterValues(options.model, sessions, (session) => session.model);
  appendFilterValues(options.model, aggregates?.byModel ?? [], (entry) => entry.model);
  appendFilterValues(options.tool, aggregates?.tools.tools ?? [], (entry) => entry.name);
  return options;
}
