import { nothing } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import type { UsageState } from "./controllers/usage.ts";
import { loadUsage, loadSessionTimeSeries, loadSessionLogs } from "./controllers/usage.ts";
import { renderUsage } from "./views/usage.ts";

// Module-scope debounce for usage date changes (avoids type-unsafe hacks on state object)
let usageDateDebounceTimeout: number | null = null;
const debouncedLoadUsage = (state: UsageState) => {
  if (usageDateDebounceTimeout) {
    clearTimeout(usageDateDebounceTimeout);
  }
  usageDateDebounceTimeout = window.setTimeout(() => void loadUsage(state), 400);
};

export function renderUsageTab(state: AppViewState) {
  if (state.tab !== "usage") {
    return nothing;
  }

  return renderUsage({
    loading: state.usageLoading,
    error: state.usageError,
    startDate: state.usageStartDate,
    endDate: state.usageEndDate,
    sessions: state.usageResult?.sessions ?? [],
    sessionsLimitReached: (state.usageResult?.sessions?.length ?? 0) >= 1000,
    totals: state.usageResult?.totals ?? null,
    aggregates: state.usageResult?.aggregates ?? null,
    costDaily: state.usageCostSummary?.daily ?? [],
    selectedSessions: state.usageSelectedSessions,
    selectedDays: state.usageSelectedDays,
    selectedHours: state.usageSelectedHours,
    chartMode: state.usageChartMode,
    dailyChartMode: state.usageDailyChartMode,
    timeSeriesMode: state.usageTimeSeriesMode,
    timeSeriesBreakdownMode: state.usageTimeSeriesBreakdownMode,
    timeSeries: state.usageTimeSeries,
    timeSeriesLoading: state.usageTimeSeriesLoading,
    timeSeriesCursorStart: state.usageTimeSeriesCursorStart,
    timeSeriesCursorEnd: state.usageTimeSeriesCursorEnd,
    sessionLogs: state.usageSessionLogs,
    sessionLogsLoading: state.usageSessionLogsLoading,
    sessionLogsExpanded: state.usageSessionLogsExpanded,
    logFilterRoles: state.usageLogFilterRoles,
    logFilterTools: state.usageLogFilterTools,
    logFilterHasTools: state.usageLogFilterHasTools,
    logFilterQuery: state.usageLogFilterQuery,
    query: state.usageQuery,
    queryDraft: state.usageQueryDraft,
    sessionSort: state.usageSessionSort,
    sessionSortDir: state.usageSessionSortDir,
    recentSessions: state.usageRecentSessions,
    sessionsTab: state.usageSessionsTab,
    visibleColumns: state.usageVisibleColumns as import("./views/usage.ts").UsageColumnId[],
    timeZone: state.usageTimeZone,
    contextExpanded: state.usageContextExpanded,
    headerPinned: state.usageHeaderPinned,
    onStartDateChange: (date) => {
      state.usageStartDate = date;
      state.usageSelectedDays = [];
      state.usageSelectedHours = [];
      state.usageSelectedSessions = [];
      debouncedLoadUsage(state);
    },
    onEndDateChange: (date) => {
      state.usageEndDate = date;
      state.usageSelectedDays = [];
      state.usageSelectedHours = [];
      state.usageSelectedSessions = [];
      debouncedLoadUsage(state);
    },
    onRefresh: () => loadUsage(state),
    onTimeZoneChange: (zone) => {
      state.usageTimeZone = zone;
      state.usageSelectedDays = [];
      state.usageSelectedHours = [];
      state.usageSelectedSessions = [];
      void loadUsage(state);
    },
    onToggleContextExpanded: () => {
      state.usageContextExpanded = !state.usageContextExpanded;
    },
    onToggleSessionLogsExpanded: () => {
      state.usageSessionLogsExpanded = !state.usageSessionLogsExpanded;
    },
    onLogFilterRolesChange: (next) => {
      state.usageLogFilterRoles = next;
    },
    onLogFilterToolsChange: (next) => {
      state.usageLogFilterTools = next;
    },
    onLogFilterHasToolsChange: (next) => {
      state.usageLogFilterHasTools = next;
    },
    onLogFilterQueryChange: (next) => {
      state.usageLogFilterQuery = next;
    },
    onLogFilterClear: () => {
      state.usageLogFilterRoles = [];
      state.usageLogFilterTools = [];
      state.usageLogFilterHasTools = false;
      state.usageLogFilterQuery = "";
    },
    onToggleHeaderPinned: () => {
      state.usageHeaderPinned = !state.usageHeaderPinned;
    },
    onSelectHour: (hour, shiftKey) => {
      if (shiftKey && state.usageSelectedHours.length > 0) {
        const allHours = Array.from({ length: 24 }, (_, i) => i);
        const lastSelected = state.usageSelectedHours[state.usageSelectedHours.length - 1];
        const lastIdx = allHours.indexOf(lastSelected);
        const thisIdx = allHours.indexOf(hour);
        if (lastIdx !== -1 && thisIdx !== -1) {
          const [start, end] = lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
          const range = allHours.slice(start, end + 1);
          state.usageSelectedHours = [...new Set([...state.usageSelectedHours, ...range])];
        }
      } else {
        if (state.usageSelectedHours.includes(hour)) {
          state.usageSelectedHours = state.usageSelectedHours.filter((h) => h !== hour);
        } else {
          state.usageSelectedHours = [...state.usageSelectedHours, hour];
        }
      }
    },
    onQueryDraftChange: (query) => {
      state.usageQueryDraft = query;
      if (state.usageQueryDebounceTimer) {
        window.clearTimeout(state.usageQueryDebounceTimer);
      }
      state.usageQueryDebounceTimer = window.setTimeout(() => {
        state.usageQuery = state.usageQueryDraft;
        state.usageQueryDebounceTimer = null;
      }, 250);
    },
    onApplyQuery: () => {
      if (state.usageQueryDebounceTimer) {
        window.clearTimeout(state.usageQueryDebounceTimer);
        state.usageQueryDebounceTimer = null;
      }
      state.usageQuery = state.usageQueryDraft;
    },
    onClearQuery: () => {
      if (state.usageQueryDebounceTimer) {
        window.clearTimeout(state.usageQueryDebounceTimer);
        state.usageQueryDebounceTimer = null;
      }
      state.usageQueryDraft = "";
      state.usageQuery = "";
    },
    onSessionSortChange: (sort) => {
      state.usageSessionSort = sort;
    },
    onSessionSortDirChange: (dir) => {
      state.usageSessionSortDir = dir;
    },
    onSessionsTabChange: (tab) => {
      state.usageSessionsTab = tab;
    },
    onToggleColumn: (column) => {
      if (state.usageVisibleColumns.includes(column)) {
        state.usageVisibleColumns = state.usageVisibleColumns.filter((entry) => entry !== column);
      } else {
        state.usageVisibleColumns = [...state.usageVisibleColumns, column];
      }
    },
    onSelectSession: (key, shiftKey) => {
      state.usageTimeSeries = null;
      state.usageSessionLogs = null;
      state.usageRecentSessions = [
        key,
        ...state.usageRecentSessions.filter((entry) => entry !== key),
      ].slice(0, 8);

      if (shiftKey && state.usageSelectedSessions.length > 0) {
        // Shift-click: select range from last selected to this session
        // Sort sessions same way as displayed (by tokens or cost descending)
        const isTokenMode = state.usageChartMode === "tokens";
        const sortedSessions = [...(state.usageResult?.sessions ?? [])].toSorted((a, b) => {
          const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
          const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
          return valB - valA;
        });
        const allKeys = sortedSessions.map((s) => s.key);
        const lastSelected = state.usageSelectedSessions[state.usageSelectedSessions.length - 1];
        const lastIdx = allKeys.indexOf(lastSelected);
        const thisIdx = allKeys.indexOf(key);
        if (lastIdx !== -1 && thisIdx !== -1) {
          const [start, end] = lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
          const range = allKeys.slice(start, end + 1);
          const newSelection = [...new Set([...state.usageSelectedSessions, ...range])];
          state.usageSelectedSessions = newSelection;
        }
      } else {
        // Regular click: focus a single session (so details always open).
        // Click the focused session again to clear selection.
        if (state.usageSelectedSessions.length === 1 && state.usageSelectedSessions[0] === key) {
          state.usageSelectedSessions = [];
        } else {
          state.usageSelectedSessions = [key];
        }
      }

      // Reset range selection when switching sessions
      state.usageTimeSeriesCursorStart = null;
      state.usageTimeSeriesCursorEnd = null;

      // Load timeseries/logs only if exactly one session selected
      if (state.usageSelectedSessions.length === 1) {
        void loadSessionTimeSeries(state, state.usageSelectedSessions[0]);
        void loadSessionLogs(state, state.usageSelectedSessions[0]);
      }
    },
    onSelectDay: (day, shiftKey) => {
      if (shiftKey && state.usageSelectedDays.length > 0) {
        // Shift-click: select range from last selected to this day
        const allDays = (state.usageCostSummary?.daily ?? []).map((d) => d.date);
        const lastSelected = state.usageSelectedDays[state.usageSelectedDays.length - 1];
        const lastIdx = allDays.indexOf(lastSelected);
        const thisIdx = allDays.indexOf(day);
        if (lastIdx !== -1 && thisIdx !== -1) {
          const [start, end] = lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
          const range = allDays.slice(start, end + 1);
          // Merge with existing selection
          const newSelection = [...new Set([...state.usageSelectedDays, ...range])];
          state.usageSelectedDays = newSelection;
        }
      } else {
        // Regular click: toggle single day
        if (state.usageSelectedDays.includes(day)) {
          state.usageSelectedDays = state.usageSelectedDays.filter((d) => d !== day);
        } else {
          state.usageSelectedDays = [day];
        }
      }
    },
    onChartModeChange: (mode) => {
      state.usageChartMode = mode;
    },
    onDailyChartModeChange: (mode) => {
      state.usageDailyChartMode = mode;
    },
    onTimeSeriesModeChange: (mode) => {
      state.usageTimeSeriesMode = mode;
    },
    onTimeSeriesBreakdownChange: (mode) => {
      state.usageTimeSeriesBreakdownMode = mode;
    },
    onTimeSeriesCursorRangeChange: (start, end) => {
      state.usageTimeSeriesCursorStart = start;
      state.usageTimeSeriesCursorEnd = end;
    },
    onClearDays: () => {
      state.usageSelectedDays = [];
    },
    onClearHours: () => {
      state.usageSelectedHours = [];
    },
    onClearSessions: () => {
      state.usageSelectedSessions = [];
      state.usageTimeSeries = null;
      state.usageSessionLogs = null;
    },
    onClearFilters: () => {
      state.usageSelectedDays = [];
      state.usageSelectedHours = [];
      state.usageSelectedSessions = [];
      state.usageTimeSeries = null;
      state.usageSessionLogs = null;
    },
  });
}
