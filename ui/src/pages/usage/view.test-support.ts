import { vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { SessionsUsageOverview } from "../../../../src/shared/usage-types.js";
import type { UsageProps, UsageSessionEntry, UsageTotals, UsageAggregates } from "./types.ts";

const noop = vi.fn();

export function usageTotals(
  input: number,
  cost: number,
  overrides: Partial<UsageTotals> = {},
): UsageTotals {
  return {
    ...createEmptyCostUsageTotals(),
    input,
    totalTokens: input,
    totalCost: cost,
    inputCost: cost,
    ...overrides,
  };
}

export function usageSession(
  key: string,
  agentId: string,
  provider: string,
  totalsOverrides: Partial<UsageTotals> = {},
): UsageSessionEntry {
  const totals: UsageTotals = {
    ...createEmptyCostUsageTotals(),
    input: 100,
    output: 20,
    totalTokens: 120,
    totalCost: 1,
    inputCost: 0.8,
    outputCost: 0.2,
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
      messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
      modelUsage: [{ provider, model: `${provider}-model`, count: 1, totals }],
    },
  };
}

export function createUsageProps(overrides: Partial<UsageProps> = {}): UsageProps {
  const props: UsageProps = {
    data: {
      loading: false,
      read: null,
      exporting: false,
      error: null,
      partialNotice: null,
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
        read: null,
        status: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      },
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesRead: null,
      timeSeriesStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsRead: null,
      sessionLogsStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      sessionLogsExpanded: false,
      logFilters: { roles: [], tools: [], hasTools: false, query: "" },
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
      display: { onExportJson: noop, onExportCsv: noop, onPageChange: noop, onChange: noop },
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
    props.data.overview = projectUsageData(props.data.sessions, props.filters).overview;
  }
  return props;
}

export function usageFixture(
  data: Partial<UsageProps["data"]> = {},
  filters: Partial<UsageProps["filters"]> = {},
  display: Partial<UsageProps["display"]> = {},
): UsageProps {
  const base = createUsageProps();
  return createUsageProps({
    data: { ...base.data, ...data },
    filters: { ...base.filters, ...filters },
    display: { ...base.display, ...display },
  });
}

export function createUsageOverview(
  overrides: Partial<NonNullable<UsageProps["data"]["overview"]>> = {},
): NonNullable<UsageProps["data"]["overview"]> {
  const overview = projectUsageData([]).overview!;
  delete overview.selectedUsageComplete;
  delete overview.usageReport;
  return Object.assign(overview, overrides);
}

export function projectUsageData(
  sessions: UsageSessionEntry[],
  filters: Partial<UsageProps["filters"]> = {},
): Pick<UsageProps["data"], "sessions" | "totals" | "aggregates" | "overview" | "costDaily"> {
  const result = buildUsageOverview({
    rows: sessions,
    options: filters,
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
  });
  return { ...result, costDaily: result.aggregates.costDaily ?? [] };
}

export const buildAggregatesFromSessions = (
  sessions: UsageSessionEntry[],
  fallback?: UsageAggregates | null,
): UsageAggregates => {
  if (!sessions.length && fallback) {
    return fallback;
  }
  const accumulator = createUsageAggregateAccumulator();
  for (const session of sessions) {
    accumulator.add(session);
  }
  const result = accumulator.finish();
  if (sessions.length) {
    return result;
  }
  const { messages, tools, byModel, byProvider, byAgent, byChannel, daily } = result;
  return { messages, tools, byModel, byProvider, byAgent, byChannel, daily };
};

function filterValues(values: (string | undefined)[], limit = 12): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, limit);
}

export function buildUsageFilterOptions(
  sessions: readonly UsageSessionEntry[],
  aggregates?: UsageAggregates | null,
): SessionsUsageOverview["filterOptions"] {
  return {
    agent: filterValues(
      sessions.map((session) => session.agentId),
      6,
    ),
    channel: filterValues(sessions.map((session) => session.channel)),
    provider: filterValues([
      ...sessions.map((session) => session.modelProvider),
      ...sessions.map((session) => session.providerOverride),
      ...(aggregates?.byProvider ?? []).map((entry) => entry.provider),
    ]),
    model: filterValues([
      ...sessions.map((session) => session.model),
      ...(aggregates?.byModel ?? []).map((entry) => entry.model),
    ]),
    tool: filterValues((aggregates?.tools.tools ?? []).map((entry) => entry.name)),
  };
}
