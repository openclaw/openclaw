import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createStore, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import type { SessionUsageQuery } from "../../lib/sessions/usage.ts";
import { isUsageCacheIncomplete, resolveUsagePublication } from "./cache-status.ts";
import { createUsageExportRequest } from "./export.ts";
import { createDefaultUsageDateRange, toggleUsageRangeSelection } from "./helpers.ts";
import { createProviderUsageLoader } from "./provider-usage-load.ts";
import { UsageRefreshPolicy } from "./refresh-policy.ts";
import { requestUsageSnapshot } from "./request-usage-snapshot.ts";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { createUsageDetails } from "./usage-details.ts";

type UsagePresentation = {
  display: Pick<
    UsageProps["display"],
    "chartMode" | "dailyChartMode" | "contextExpanded" | "headerPinned"
  >;
  detail: Pick<
    UsageProps["detail"],
    | "timeSeriesMode"
    | "timeSeriesBreakdownMode"
    | "timeSeriesCursorStart"
    | "timeSeriesCursorEnd"
    | "sessionLogsExpanded"
    | "logFilters"
  >;
};
type UsageOwnerView = Omit<UsageProps, "display" | "detail"> & {
  result: SessionsUsageResult | null;
  display: Omit<UsageProps["display"], keyof UsagePresentation["display"]>;
  detail: Omit<UsageProps["detail"], keyof UsagePresentation["detail"]>;
};

export function createUsagePage(context: ApplicationContext) {
  let publish = () => {};
  const notify = () => publish();

  let usageSnapshot: {
    query: SessionUsageQuery;
    result: SessionsUsageResult | null;
    costSummary: CostUsageSummary | null;
  } | null = null;
  let usageError: string | null = null;
  let sessionLoadedAtMs: number | null = null;
  let filters: Omit<UsageProps["filters"], "selectedSessions"> = {
    ...createDefaultUsageDateRange(),
    scope: "family",
    creatorKey: null,
    selectedDays: [],
    selectedHours: [],
    query: "",
    queryDraft: "",
    timeZone: "local",
  };
  // Sorting and recent selection belong to the next request, before Solid commits.
  let display: UsageOwnerView["display"] = {
    sessionSort: "recent",
    sessionSortDir: "desc",
    recentSessions: [],
    sessionsTab: "all",
  };
  const [presentation, setPresentation] = createStore<UsagePresentation>({
    display: {
      chartMode: "tokens",
      dailyChartMode: "by-type",
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      timeSeriesMode: "per-turn",
      timeSeriesBreakdownMode: "by-type",
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogsExpanded: false,
      logFilters: { roles: [], tools: [], hasTools: false, query: "" },
    },
  });
  let usageSelectedSessions: string[] = [];
  let usageOffset = 0;
  let selectedSession: UsageProps["data"]["selectedSession"] = null;
  let usageAgentId: string | null = null;
  const timers: { dateDebounceTimer: number | null; queryDebounceTimer: number | null } = {
    dateDebounceTimer: null,
    queryDebounceTimer: null,
  };
  // The client survives transport reconnects, so retry budgets need a separate epoch.
  let connectionEpoch: object = {};
  let usageUpdatedAt = 0;
  // Publication and reconnect replace immutable receipts, retiring their acknowledgments.
  const acknowledgedUsageFailures = new WeakSet<
    ReturnType<typeof resolveUsagePublication>["failures"][number]
  >();
  let routeDataInitialized = false;
  let routeDataEnabled = true;
  const refreshPolicy = new UsageRefreshPolicy({
    isLoading: usageLoading,
    reload: (reason) => {
      // Retries exist for incomplete provider plans; they never re-read session usage.
      if (reason === "poll") {
        return providerUsage.load();
      }
      if (reason === "manual") {
        usageUpdatedAt = usagePublication().updatedAt;
      }
      clearDebounce("dateDebounceTimer");
      const sessionKey =
        reason === "manual" && usageSelectedSessions.length === 1
          ? usageSelectedSessions[0]
          : undefined;
      return loadAll(sessionKey);
    },
    onIncompleteUsageExhausted: notify,
  });
  const gateway = new GatewayPageBinding(notify, {
    getGateway: () => context.gateway,
    onIdentityChange: resetForClientChange,
    invalidateRequests: (change) => {
      if (change.snapshot.phase === "connected") {
        return;
      }
      refreshPolicy.interrupt();
      usageRequest.reset();
      providerUsage.cancel();
      details.cancel();
    },
    onSnapshot: handleGatewaySnapshot,
    onPageActivation: () => void refreshPolicy.request("focus"),
  });
  const observeAgentScope = watchAgentScope((scopeId) => {
    if (routeDataInitialized && usageAgentId !== scopeId) {
      usageAgentId = scopeId;
      setFilters({ creatorKey: null });
      clearSelectionsAndDetails();
      void refreshPolicy.request("manual");
    }
    notify();
  });

  const usageRequest = createPageRequest(notify, {
    task: async (
      [client, refreshSessionKey]: readonly [GatewayBrowserClient, string | undefined],
      { signal },
    ) => {
      refreshPolicy.beginLoad();
      const epoch = connectionEpoch;
      const query = currentQuery();
      return {
        epoch,
        query,
        refreshSessionKey,
        snapshot: await requestUsageSnapshot(client, query, signal),
      };
    },
    onComplete: (value) => {
      const snapshot = value.snapshot;
      const current = isCurrentQuery(value.query);
      if (current && snapshot.ok) {
        const result = snapshot.value.result;
        const refreshSummary = usageSnapshot?.result?.updatedAt !== result.updatedAt;
        usageSnapshot = {
          query: value.query,
          result,
          costSummary: snapshot.value.costSummary,
        };
        usageError = null;
        const sessionKey =
          usageSelectedSessions.length === 1 ? usageSelectedSessions[0] : undefined;
        if (sessionKey) {
          selectedSession = result.overview?.selectedRows[0] ?? selectedSession;
          // Manual intent belongs to this request's selection, never a later poll or selection.
          details.load(sessionKey, value.refreshSessionKey === sessionKey, refreshSummary);
        }
      } else if (current && !snapshot.ok) {
        applyUsageError(snapshot.error.cause);
      }
      markUsageLoaded(value.epoch, current && snapshot.ok ? Date.now() : null);
      refreshPolicy.flushPending();
    },
    onError: (error) => {
      applyUsageError(error);
      markUsageLoaded(connectionEpoch, null);
      refreshPolicy.flushPending();
    },
  });

  const usageExportRequest = createUsageExportRequest(notify, gateway, currentQuery);

  const details = createUsageDetails(
    notify,
    gateway,
    currentQuery,
    () =>
      selectedSession
        ? [...(usageRosterResult()?.sessions ?? []), selectedSession]
        : (usageRosterResult()?.sessions ?? []),
    () => {
      setPresentation((draft) => {
        draft.detail.timeSeriesCursorStart = null;
        draft.detail.timeSeriesCursorEnd = null;
      });
    },
  );

  function setRouteData(data: UsageRouteData | undefined): void {
    applyRouteData(data);
    if (
      !routeDataEnabled &&
      routeDataInitialized &&
      gateway.client &&
      gateway.connected &&
      !usageLoading()
    ) {
      void loadAll();
    }
    notify();
  }

  function applyRouteData(data: UsageRouteData | undefined) {
    if (!data) {
      return;
    }
    routeDataInitialized = true;
    if (!routeDataEnabled) {
      return;
    }
    if (!gateway.isRouteDataCurrent(data)) {
      routeDataEnabled = false;
      return;
    }
    const currentAgentId = context.agentSelection.state.scopeId;
    if (data.query.agentId !== currentAgentId) {
      usageAgentId = currentAgentId;
      clearSelectionsAndDetails();
      resetProviderUsage();
      void refreshPolicy.request("manual");
      return;
    }

    const { startDate, endDate, scope, timeZone, creatorKey } = data.query;
    setFilters({ startDate, endDate, scope, timeZone, creatorKey: creatorKey ?? null });
    usageAgentId = data.query.agentId;
    usageSnapshot = {
      query: currentQuery(),
      result: data.result,
      costSummary: data.costSummary,
    };
    markUsageLoaded(connectionEpoch, data.loadedAtMs);
    void providerUsage.load();
    usageError = data.error;
    const preloadUpdatedAt = resolveUsagePublication(
      data.gatewaySnapshot.usagePublications,
      currentQuery().agentId,
    ).updatedAt;
    if (usagePublication().committedAt > preloadUpdatedAt) {
      void refreshPolicy.request("publication");
    }
    refreshPolicy.flushPending();
  }

  function resetForClientChange() {
    clearDebounce("dateDebounceTimer");
    usageRequest.reset();
    if (routeDataInitialized) {
      routeDataEnabled = false;
    }
    usageSnapshot = null;
    providerUsage.cancel();
    resetProviderUsage();
    usageError = null;
    usageAgentId = context.agentSelection.state.scopeId;
    setFilters({ creatorKey: null });
    clearSelectionsAndDetails();
  }

  function resetProviderUsage() {
    sessionLoadedAtMs = null;
    providerUsage.reset();
    refreshPolicy.resetPayload();
  }

  // Only the session read owns freshness: a provider result reuses the last session timestamp,
  // so provider plans add their retry state and never make a failed session read look fresh.
  // Session rollups converge on publication; only provider usage needs timed retries.
  function markUsageLoaded(connection: unknown, loadedAtMs = sessionLoadedAtMs): void {
    sessionLoadedAtMs = loadedAtMs;
    refreshPolicy.setLastLoadedAtMs(usageCacheIncomplete() ? null : loadedAtMs, {
      incomplete: providerUsage.incomplete,
      connection,
    });
  }

  const providerUsage = createProviderUsageLoader({
    client: () => (gateway.connected ? gateway.client : null),
    epoch: () => connectionEpoch,
    isCurrent: (epoch) => epoch === connectionEpoch,
    onResult: (epoch) => markUsageLoaded(epoch),
    onSettled: () => {
      refreshPolicy.flushPending();
      notify();
    },
  });

  function usagePublication() {
    return resolveUsagePublication(gateway.snapshot?.usagePublications, currentQuery().agentId);
  }

  function usageRefreshFailed(): boolean {
    return usagePublication().failures.some((receipt) => !acknowledgedUsageFailures.has(receipt));
  }

  function usageCacheIncomplete(): boolean {
    return isUsageCacheIncomplete(usageResult()?.cacheStatus, usageCalendarSummary()?.cacheStatus);
  }

  function currentQuery(): SessionUsageQuery {
    return {
      startDate: filters.startDate,
      endDate: filters.endDate,
      scope: filters.scope,
      timeZone: filters.timeZone,
      agentId: normalizeLowercaseStringOrEmpty(usageAgentId ?? "") || undefined,
      creatorKey: filters.creatorKey ?? undefined,
      query: filters.query,
      selectedDays: filters.selectedDays,
      selectedHours: filters.selectedHours,
      selectedSessions: usageSelectedSessions,
      recentKeys: display.sessionsTab === "recent" ? display.recentSessions : undefined,
      offset: usageOffset,
      sort: display.sessionSort,
      sortDirection: display.sessionSortDir,
    };
  }

  function isCurrentQuery(
    query: SessionUsageQuery,
    projection: "all" | "roster" | "calendar" = "all",
  ): boolean {
    const current = currentQuery();
    return (
      query.startDate === current.startDate &&
      query.endDate === current.endDate &&
      query.scope === current.scope &&
      query.timeZone === current.timeZone &&
      query.agentId === current.agentId &&
      query.creatorKey === current.creatorKey &&
      query.query === current.query &&
      (projection === "calendar" ||
        JSON.stringify(query.selectedDays) === JSON.stringify(current.selectedDays)) &&
      JSON.stringify(query.selectedHours) === JSON.stringify(current.selectedHours) &&
      (projection === "roster" ||
        JSON.stringify(query.selectedSessions) === JSON.stringify(current.selectedSessions)) &&
      (projection === "calendar" ||
        (JSON.stringify(query.recentKeys) === JSON.stringify(current.recentKeys) &&
          query.offset === current.offset &&
          query.sort === current.sort &&
          query.sortDirection === current.sortDirection))
    );
  }

  function usageRosterResult(): SessionsUsageResult | null {
    return usageSnapshot && isCurrentQuery(usageSnapshot.query, "roster")
      ? usageSnapshot.result
      : null;
  }

  function usageResult(): SessionsUsageResult | null {
    return usageSnapshot && isCurrentQuery(usageSnapshot.query) ? usageSnapshot.result : null;
  }

  function usageCalendarSummary(): CostUsageSummary | null {
    // Day selection changes totals, but the same calendar remains available for Shift-click.
    return usageSnapshot && isCurrentQuery(usageSnapshot.query, "calendar")
      ? usageSnapshot.costSummary
      : null;
  }

  function usageCreatorOptions() {
    // Keep the selector usable during a filter change, but never carry another
    // agent's identities across an agent or Gateway replacement.
    return usageSnapshot?.query.agentId === currentQuery().agentId
      ? (usageSnapshot?.result?.creatorOptions ?? [])
      : [];
  }

  function applyUsageError(error: unknown) {
    const missingScope = isMissingOperatorReadScopeError(error);
    usageError = missingScope
      ? formatMissingOperatorReadScopeMessage("usage")
      : formatUiError(error, "request failed");
    if (missingScope) {
      usageSnapshot = null;
    }
  }

  function usageLoading(): boolean {
    return !routeDataInitialized || timers.dateDebounceTimer !== null || usageRequest.pending;
  }

  function loadAll(refreshSessionKey?: string): Promise<void> {
    return Promise.all([loadUsage(refreshSessionKey), providerUsage.load()]).then(() => undefined);
  }

  function loadUsage(refreshSessionKey?: string): Promise<void> {
    const client = gateway.client;
    if (!client || !gateway.connected) {
      refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    // Filter changes must supersede active work; the request fences the old result
    // so it cannot publish under the newly rendered query controls.
    routeDataEnabled = false;
    usageError = null;
    return usageRequest.run([client, refreshSessionKey]);
  }

  function setFilters(next: Partial<typeof filters>) {
    filters = { ...filters, ...next };
    notify();
  }

  function clearSelectionsAndDetails() {
    usageExportRequest.reset();
    setFilters({ selectedDays: [], selectedHours: [] });
    usageSelectedSessions = [];
    selectedSession = null;
    usageOffset = 0;
    details.clear();
  }

  function clearDebounce(timer: "dateDebounceTimer" | "queryDebounceTimer") {
    if (timers[timer] !== null) {
      window.clearTimeout(timers[timer]);
      timers[timer] = null;
    }
  }

  function scheduleUsageLoad() {
    clearSelectionsAndDetails();
    clearDebounce("dateDebounceTimer");
    usageRequest.reset();
    usageError = null;
    // Cancel the old query's poll before it can consume this debounce and retry budget.
    refreshPolicy.resetPayload();
    routeDataEnabled = false;
    timers.dateDebounceTimer = window.setTimeout(() => {
      timers.dateDebounceTimer = null;
      void refreshPolicy.request("manual");
    }, 400);
  }

  function handleGatewaySnapshot(change: GatewayPageChange) {
    if (!gateway.connected || !gateway.client) {
      return;
    }
    void context.agents.ensureList();
    const publication = usagePublication();
    const usageCommitted = publication.committedAt > usageUpdatedAt;
    usageUpdatedAt = publication.updatedAt;
    if (change.identityChanged || change.becameConnected) {
      connectionEpoch = {};
      if (routeDataInitialized) {
        void refreshPolicy.request("reconnect").then(() => providerUsage.resume());
      }
    } else if (usageCommitted && routeDataInitialized) {
      void refreshPolicy.request("publication");
    }
    const sessionKey = usageSelectedSessions.length === 1 ? usageSelectedSessions[0] : undefined;
    if (change.becameAvailable && sessionKey) {
      for (const detail of [details.timeSeries, details.sessionLogs, details.session]) {
        void detail.recover(sessionKey, detail === details.session);
      }
    }
  }

  function selectSession(key: string, shiftKey: boolean, orderedKeys: string[]) {
    const selectedRow =
      usageRosterResult()?.sessions.find((session) => session.key === key) ??
      usageResult()?.overview?.selectedRows.find((session) => session.key === key);
    details.clear();
    display = {
      ...display,
      recentSessions: [key, ...display.recentSessions.filter((entry) => entry !== key)].slice(0, 8),
    };

    usageSelectedSessions = toggleUsageRangeSelection(
      usageSelectedSessions,
      key,
      orderedKeys,
      shiftKey,
      "replace",
    );

    selectedSession = usageSelectedSessions.length === 1 ? (selectedRow ?? selectedSession) : null;
    void loadUsage();
    if (usageSelectedSessions.length === 1) {
      const sessionKey = usageSelectedSessions[0];
      if (sessionKey) {
        details.load(sessionKey);
      }
    }
  }

  function refreshOverview() {
    usageOffset = 0;
    void loadUsage();
  }

  function applyQuery() {
    clearDebounce("queryDebounceTimer");
    setFilters({ query: filters.queryDraft });
    refreshOverview();
  }

  function read(): UsageOwnerView {
    const timeSeries = details.timeSeries.data;
    return {
      result: usageResult(),
      data: {
        loading: usageLoading(),
        exporting: usageExportRequest.pending,
        error: usageError ?? usageResult()?.partial?.message ?? null,
        sessions: usageRosterResult()?.sessions ?? [],
        sessionPage: usageRosterResult()?.overview,
        creatorOptions: usageCreatorOptions(),
        overview: usageResult()?.overview,
        selectedSession: details.session.data ?? selectedSession,
        totals: usageResult()?.totals ?? null,
        aggregates: usageResult()?.aggregates ?? null,
        costDaily: usageCalendarSummary()?.daily ?? [],
        cacheRefresh: usageCacheIncomplete()
          ? usageRefreshFailed()
            ? "failed"
            : "retrying"
          : "complete",
        providerUsage: providerUsage.summary?.providers ?? [],
        providerUsageStalled: providerUsage.incomplete && refreshPolicy.incompleteUsageExhausted,
        providerUsageUnavailable: providerUsage.unavailable,
      },
      filters: { ...filters, selectedSessions: usageSelectedSessions },
      display,
      detail: {
        context: {
          weight: details.session.data?.contextWeight,
          loading: details.session.loading,
          status: details.session.status,
        },
        timeSeries,
        timeSeriesLoading: details.timeSeries.loading,
        timeSeriesStatus: details.timeSeries.status,
        sessionLogs: details.sessionLogs.data,
        sessionLogsLoading: details.sessionLogs.loading,
        sessionLogsStatus: details.sessionLogs.status,
      },
      callbacks: {
        filters: {
          onDatesChange: (dates) => {
            setFilters(dates);
            scheduleUsageLoad();
          },
          onScopeChange: (scope) => {
            setFilters(scope);
            clearSelectionsAndDetails();
            void refreshPolicy.request("manual");
          },
          onRefresh: () => {
            for (const receipt of usagePublication().failures) {
              acknowledgedUsageFailures.add(receipt);
            }
            return refreshPolicy.request("manual");
          },
          onToggleHeaderPinned: () => {
            setPresentation((draft) => {
              draft.display.headerPinned = !draft.display.headerPinned;
            });
          },
          onSelectHour: (hour, shiftKey) => {
            setFilters({
              selectedHours: toggleUsageRangeSelection(
                filters.selectedHours,
                hour,
                Array.from({ length: 24 }, (_, index) => index),
                shiftKey,
                "append",
              ),
            });
            refreshOverview();
          },
          onQueryDraftChange: (query) => {
            setFilters({ queryDraft: query });
            clearDebounce("queryDebounceTimer");
            timers.queryDebounceTimer = window.setTimeout(() => {
              timers.queryDebounceTimer = null;
              applyQuery();
            }, 250);
          },
          onApplyQuery: applyQuery,
          onClearQuery: () => {
            clearDebounce("queryDebounceTimer");
            setFilters({ queryDraft: "", query: "" });
            refreshOverview();
          },
          onSelectDay: (day, shiftKey, orderedDays) => {
            setFilters({
              selectedDays: toggleUsageRangeSelection(
                filters.selectedDays,
                day,
                orderedDays,
                shiftKey,
                "toggle",
              ),
            });
            refreshOverview();
          },
          onClearDays: () => {
            setFilters({ selectedDays: [] });
            refreshOverview();
          },
          onClearHours: () => {
            setFilters({ selectedHours: [] });
            refreshOverview();
          },
          onClearSessions: () => {
            usageSelectedSessions = [];
            selectedSession = null;
            details.clear();
            void loadUsage();
          },
          onClearFilters: () => {
            clearSelectionsAndDetails();
            refreshOverview();
          },
        },
        display: {
          onExportJson: () => {
            void usageExportRequest.run("json");
          },
          onExportCsv: (format) => {
            void usageExportRequest.run(format);
          },
          onPageChange: (offset) => {
            usageOffset = offset;
            void loadUsage();
          },
          onChange: (next) => {
            const { sessionSort, sessionSortDir, sessionsTab, recentSessions, ...local } = next;
            display = {
              sessionSort: sessionSort ?? display.sessionSort,
              sessionSortDir: sessionSortDir ?? display.sessionSortDir,
              sessionsTab: sessionsTab ?? display.sessionsTab,
              recentSessions: recentSessions ?? display.recentSessions,
            };
            setPresentation((draft) => {
              Object.assign(draft.display, local);
            });
            if (
              next.sessionSort !== undefined ||
              next.sessionSortDir !== undefined ||
              next.sessionsTab !== undefined
            ) {
              refreshOverview();
            }
            notify();
          },
        },
        details: {
          onToggleContextExpanded: () => {
            setPresentation((draft) => {
              draft.display.contextExpanded = !draft.display.contextExpanded;
            });
          },
          onToggleSessionLogsExpanded: () => {
            setPresentation((draft) => {
              draft.detail.sessionLogsExpanded = !draft.detail.sessionLogsExpanded;
            });
          },
          onLogFiltersChange: (next) => {
            setPresentation((draft) => {
              Object.assign(draft.detail.logFilters, next);
            });
          },
          onSelectSession: selectSession,
          onTimeSeriesModeChange: (mode) => {
            setPresentation((draft) => {
              draft.detail.timeSeriesMode = mode;
            });
          },
          onTimeSeriesBreakdownChange: (mode) => {
            setPresentation((draft) => {
              draft.detail.timeSeriesBreakdownMode = mode;
            });
          },
          onTimeSeriesCursorRangeChange: (start, end) => {
            if (details.timeSeries.data === timeSeries) {
              setPresentation((draft) => {
                draft.detail.timeSeriesCursorStart = start;
                draft.detail.timeSeriesCursorEnd = end;
              });
            }
          },
        },
      },
    };
  }
  const projection = projectMutableSource(context, read);
  publish = projection.publish;
  gateway.connect();
  const stopAgentScope = observeAgentScope(context.agentSelection);
  onCleanup(() => {
    publish = () => {};
    stopAgentScope();
    clearDebounce("dateDebounceTimer");
    clearDebounce("queryDebounceTimer");
    refreshPolicy.dispose();
    usageRequest.reset();
    details.cancel();
    usageExportRequest.reset();
    gateway.dispose();
  });

  return {
    read(): UsageProps {
      const state = projection.read();
      return {
        ...state,
        display: { ...state.display, ...presentation.display },
        detail: { ...state.detail, ...presentation.detail },
      };
    },
    setRouteData,
    result: () => projection.read().result,
  };
}
