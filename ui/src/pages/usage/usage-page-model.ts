import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
import type { SessionUsageQuery } from "../../lib/sessions/usage.ts";
import { isUsageCacheIncomplete, resolveUsagePublication } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { UsageDetailsController } from "./detail-controller.ts";
import { createUsageExportRequest } from "./export.ts";
import { createDefaultUsageDateRange, toggleUsageRangeSelection } from "./helpers.ts";
import { UsageRefreshPolicy } from "./refresh-policy.ts";
import { type ProviderUsageSnapshot, requestUsageSnapshot } from "./request-usage-snapshot.ts";
import { createUsageRequest } from "./request.ts";
import type { UsageProps, UsageRouteData } from "./types.ts";

export type { UsageRouteData } from "./types.ts";

export class UsagePageModel {
  routeData?: UsageRouteData;

  constructor(
    public context: ApplicationContext,
    private readonly notify: () => void,
  ) {}

  private usageSnapshot: {
    query: SessionUsageQuery;
    result: SessionsUsageResult | null;
    costSummary: CostUsageSummary | null;
  } | null = null;
  private providerUsageSummary: ProviderUsageSummary | null = null;
  private providerUsageUnavailable = false;
  private providerUsageIncomplete = false;
  private usageError: string | null = null;
  private filters: Omit<UsageProps["filters"], "selectedSessions"> = {
    ...createDefaultUsageDateRange(),
    scope: "family",
    creatorKey: null,
    selectedDays: [],
    selectedHours: [],
    query: "",
    queryDraft: "",
    timeZone: "local",
  };
  private display: UsageProps["display"] = {
    chartMode: "tokens",
    dailyChartMode: "by-type",
    sessionSort: "recent",
    sessionSortDir: "desc",
    recentSessions: [],
    contextExpanded: false,
    headerPinned: false,
    sessionsTab: "all",
  };
  private logFilters: UsageProps["detail"]["logFilters"] = {
    roles: [],
    tools: [],
    hasTools: false,
    query: "",
  };
  private usageSelectedSessions: string[] = [];
  private usageOffset = 0;
  private selectedSession: UsageProps["data"]["selectedSession"] = null;
  private usageAgentId: string | null = null;
  private usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  private usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  private usageTimeSeriesCursorStart: number | null = null;
  private usageTimeSeriesCursorEnd: number | null = null;
  private usageSessionLogsExpanded = false;

  private dateDebounceTimer: number | null = null;
  private queryDebounceTimer: number | null = null;
  // The client survives transport reconnects, so retry budgets need a separate epoch.
  private connectionEpoch: object = {};
  private usageUpdatedAt = 0;
  // Publication and reconnect replace immutable receipts, retiring their acknowledgments.
  private readonly acknowledgedUsageFailures = new WeakSet<
    ReturnType<typeof resolveUsagePublication>["failures"][number]
  >();
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () => this.usageLoading,
    reload: (reason) => {
      if (reason === "manual") {
        this.usageUpdatedAt = this.usagePublication.updatedAt;
      }
      this.clearDebounce("dateDebounceTimer");
      const sessionKey =
        reason === "manual" && this.usageSelectedSessions.length === 1
          ? this.usageSelectedSessions[0]
          : undefined;
      return this.loadUsage(sessionKey);
    },
    onIncompleteUsageExhausted: () => this.notify(),
  });
  private readonly gateway = new GatewayPageBinding(() => this.notify(), {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetForClientChange(),
    invalidateRequests: (change) => {
      if (change.snapshot.phase === "connected") {
        return;
      }
      this.refreshPolicy.interrupt();
      this.usageRequest.cancel();
      this.details.cancel();
      this.usageExportRequest.cancel();
    },
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly observeAgentScope = watchAgentScope((scopeId) => {
    if (this.routeDataInitialized && this.usageAgentId !== scopeId) {
      this.usageAgentId = scopeId;
      this.setFilters({ creatorKey: null });
      this.clearSelectionsAndDetails();
      this.refreshPolicy.request("manual");
    }
    this.notify();
  });

  private readonly usageRequest = createUsageRequest(() => this.notify(), {
    task: async (
      [client, refreshSessionKey]: readonly [GatewayBrowserClient, string | undefined],
      { signal },
    ) => {
      this.refreshPolicy.beginLoad();
      const epoch = this.connectionEpoch;
      const query = this.currentQuery;
      return {
        epoch,
        query,
        refreshSessionKey,
        snapshot: await requestUsageSnapshot(client, query, signal),
      };
    },
    onComplete: (value) => {
      const snapshot = value.snapshot;
      const current = this.isCurrentQuery(value.query);
      if (current && snapshot.ok) {
        const result = snapshot.value.result;
        const refreshSummary = this.usageSnapshot?.result?.updatedAt !== result.updatedAt;
        this.usageSnapshot = {
          query: value.query,
          result,
          costSummary: snapshot.value.costSummary,
        };
        this.usageError = null;
        const sessionKey =
          this.usageSelectedSessions.length === 1 ? this.usageSelectedSessions[0] : undefined;
        if (sessionKey) {
          const selectedRow = result.sessions.find((session) => session.key === sessionKey);
          if (selectedRow) {
            this.selectedSession = selectedRow;
          }
          // Manual intent belongs to this request's selection, never a later poll or selection.
          this.details.load(sessionKey, value.refreshSessionKey === sessionKey, refreshSummary);
        }
      } else if (current && !snapshot.ok) {
        this.applyUsageError(snapshot.error.cause);
      }
      this.applyUsageLoadState(
        snapshot.ok ? snapshot.value.providerUsage : snapshot.error.providerUsage,
        value.epoch,
        current && snapshot.ok ? undefined : null,
      );
      this.refreshPolicy.flushPending();
    },
    onError: (error) => {
      this.applyUsageError(error);
      this.applyUsageLoadState({ state: "pending" }, this.connectionEpoch, null);
      this.refreshPolicy.flushPending();
    },
  });

  private readonly usageExportRequest = createUsageExportRequest(
    () => this.notify(),
    this.gateway,
    () => this.currentQuery,
  );

  private readonly details = new UsageDetailsController(
    () => this.notify(),
    this.gateway,
    () => this.currentQuery,
    () =>
      this.selectedSession
        ? [...(this.usageRosterResult?.sessions ?? []), this.selectedSession]
        : (this.usageRosterResult?.sessions ?? []),
    () => {
      this.usageTimeSeriesCursorStart = null;
      this.usageTimeSeriesCursorEnd = null;
    },
  );
  private stopAgentScope?: () => void;
  private stopAgents?: () => void;

  connect(): void {
    this.gateway.connect();
    this.stopAgentScope = this.observeAgentScope(this.context.agentSelection);
    this.stopAgents = this.context.agents.subscribe(() => this.notify());
  }

  setRouteData(data: UsageRouteData | undefined): void {
    this.routeData = data;
    this.applyRouteData();
    this.ensureInitialData();
    this.notify();
  }

  dispose(): void {
    this.stopAgentScope?.();
    this.stopAgents?.();
    this.clearDebounce("dateDebounceTimer");
    this.clearDebounce("queryDebounceTimer");
    this.refreshPolicy.dispose();
    this.usageRequest.cancel();
    this.details.cancel();
    this.usageExportRequest.cancel();
    this.gateway.dispose();
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    if (!this.routeDataEnabled) {
      return;
    }
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.routeDataEnabled = false;
      return;
    }
    const currentAgentId = this.context.agentSelection.state.scopeId;
    if (data.query.agentId !== currentAgentId) {
      this.usageAgentId = currentAgentId;
      this.clearSelectionsAndDetails();
      this.resetProviderUsage();
      this.refreshPolicy.request("manual");
      return;
    }

    const { startDate, endDate, scope, timeZone, creatorKey } = data.query;
    this.setFilters({ startDate, endDate, scope, timeZone, creatorKey: creatorKey ?? null });
    this.usageAgentId = data.query.agentId;
    this.usageSnapshot = {
      query: this.currentQuery,
      result: data.result,
      costSummary: data.costSummary,
    };
    this.applyUsageLoadState(data.providerUsage, this.connectionEpoch, data.loadedAtMs);
    this.usageError = data.error;
    const preloadUpdatedAt = resolveUsagePublication(
      data.gatewaySnapshot.usagePublications,
      this.currentQuery.agentId,
    ).updatedAt;
    if (this.usagePublication.committedAt > preloadUpdatedAt) {
      this.refreshPolicy.request("publication");
    }
    this.refreshPolicy.flushPending();
  }

  private ensureInitialData() {
    if (
      this.routeDataEnabled ||
      !this.routeDataInitialized ||
      !this.gateway.client ||
      !this.gateway.connected ||
      this.usageLoading
    ) {
      return;
    }
    void this.loadUsage();
  }

  private resetForClientChange() {
    this.clearDebounce("dateDebounceTimer");
    this.usageRequest.cancel();
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.usageSnapshot = null;
    this.resetProviderUsage();
    this.usageError = null;
    this.usageAgentId = this.context.agentSelection.state.scopeId;
    this.setFilters({ creatorKey: null });
    this.clearSelectionsAndDetails();
  }

  private resetProviderUsage() {
    this.providerUsageSummary = null;
    this.providerUsageUnavailable = false;
    this.providerUsageIncomplete = false;
    this.refreshPolicy.resetPayload();
  }

  private applyUsageLoadState(
    snapshot: ProviderUsageSnapshot,
    connection: unknown,
    loadedAtMs: number | null = Date.now(),
  ): void {
    if (snapshot.state === "settled") {
      const result = snapshot.result;
      this.providerUsageUnavailable = !result.ok;
      this.providerUsageIncomplete = !result.ok || result.value.refreshing === true;
      if (result.ok && !this.providerUsageIncomplete) {
        this.providerUsageSummary = result.value;
      }
    }
    // Session rollups converge on publication; only provider usage needs timed retries.
    this.refreshPolicy.setLastLoadedAtMs(
      snapshot.state === "pending" || this.usageCacheIncomplete ? null : loadedAtMs,
      { incomplete: this.providerUsageIncomplete, connection },
    );
  }

  private get usagePublication() {
    return resolveUsagePublication(
      this.gateway.snapshot?.usagePublications,
      this.currentQuery.agentId,
    );
  }

  private get usageRefreshFailed(): boolean {
    return this.usagePublication.failures.some(
      (receipt) => !this.acknowledgedUsageFailures.has(receipt),
    );
  }

  private get usageCacheIncomplete(): boolean {
    return isUsageCacheIncomplete(
      this.usageResult?.cacheStatus,
      this.usageCalendarSummary?.cacheStatus,
    );
  }

  private get currentQuery(): SessionUsageQuery {
    return {
      startDate: this.filters.startDate,
      endDate: this.filters.endDate,
      scope: this.filters.scope,
      timeZone: this.filters.timeZone,
      agentId: normalizeLowercaseStringOrEmpty(this.usageAgentId ?? "") || undefined,
      creatorKey: this.filters.creatorKey ?? undefined,
      query: this.filters.query,
      selectedDays: this.filters.selectedDays,
      selectedHours: this.filters.selectedHours,
      selectedSessions: this.usageSelectedSessions,
      recentKeys: this.display.sessionsTab === "recent" ? this.display.recentSessions : undefined,
      offset: this.usageOffset,
      sort: this.display.sessionSort,
      sortDirection: this.display.sessionSortDir,
    };
  }

  private isCurrentRosterQuery(query: SessionUsageQuery): boolean {
    const current = this.currentQuery;
    return (
      query.startDate === current.startDate &&
      query.endDate === current.endDate &&
      query.scope === current.scope &&
      query.timeZone === current.timeZone &&
      query.agentId === current.agentId &&
      query.creatorKey === current.creatorKey &&
      query.query === current.query &&
      JSON.stringify(query.selectedDays) === JSON.stringify(current.selectedDays) &&
      JSON.stringify(query.selectedHours) === JSON.stringify(current.selectedHours) &&
      JSON.stringify(query.recentKeys) === JSON.stringify(current.recentKeys) &&
      query.offset === current.offset &&
      query.sort === current.sort &&
      query.sortDirection === current.sortDirection
    );
  }

  private isCurrentQuery(query: SessionUsageQuery): boolean {
    return (
      this.isCurrentRosterQuery(query) &&
      JSON.stringify(query.selectedSessions) === JSON.stringify(this.currentQuery.selectedSessions)
    );
  }

  private get usageRosterResult(): SessionsUsageResult | null {
    return this.usageSnapshot && this.isCurrentRosterQuery(this.usageSnapshot.query)
      ? this.usageSnapshot.result
      : null;
  }

  get usageResult(): SessionsUsageResult | null {
    return this.usageSnapshot && this.isCurrentQuery(this.usageSnapshot.query)
      ? this.usageSnapshot.result
      : null;
  }

  private get usageCalendarSummary(): CostUsageSummary | null {
    const previous = this.usageSnapshot?.query;
    const current = this.currentQuery;
    if (
      !previous ||
      previous.startDate !== current.startDate ||
      previous.endDate !== current.endDate ||
      previous.scope !== current.scope ||
      previous.timeZone !== current.timeZone ||
      previous.agentId !== current.agentId ||
      previous.creatorKey !== current.creatorKey ||
      previous.query !== current.query ||
      JSON.stringify(previous.selectedHours) !== JSON.stringify(current.selectedHours) ||
      JSON.stringify(previous.selectedSessions) !== JSON.stringify(current.selectedSessions)
    ) {
      return null;
    }
    // Day selection changes totals, but the same calendar remains available for Shift-click.
    return this.usageSnapshot?.costSummary ?? null;
  }

  private get usageCreatorOptions() {
    // Keep the selector usable during a filter change, but never carry another
    // agent's identities across an agent or Gateway replacement.
    return this.usageSnapshot?.query.agentId === this.currentQuery.agentId
      ? (this.usageSnapshot?.result?.creatorOptions ?? [])
      : [];
  }

  private applyUsageError(error: unknown) {
    const missingScope = isMissingOperatorReadScopeError(error);
    this.usageError = missingScope
      ? formatMissingOperatorReadScopeMessage("usage")
      : formatUiError(error, "request failed");
    if (missingScope) {
      this.usageSnapshot = null;
    }
  }

  private get usageLoading(): boolean {
    return (
      !this.routeDataInitialized || this.dateDebounceTimer !== null || this.usageRequest.pending
    );
  }

  private loadUsage(refreshSessionKey?: string): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    // Filter changes must supersede active work; the request fences the old result
    // so it cannot publish under the newly rendered query controls.
    this.routeDataEnabled = false;
    this.usageError = null;
    return this.usageRequest.run([client, refreshSessionKey]);
  }

  private setFilters(next: Partial<typeof this.filters>) {
    this.filters = { ...this.filters, ...next };
    this.notify();
  }

  private clearSelectionsAndDetails() {
    this.usageExportRequest.cancel();
    this.setFilters({ selectedDays: [], selectedHours: [] });
    this.usageSelectedSessions = [];
    this.selectedSession = null;
    this.usageOffset = 0;
    this.details.clear();
  }

  private clearDebounce(timer: "dateDebounceTimer" | "queryDebounceTimer") {
    if (this[timer] !== null) {
      window.clearTimeout(this[timer]);
      this[timer] = null;
    }
  }

  private scheduleUsageLoad() {
    this.clearSelectionsAndDetails();
    this.clearDebounce("dateDebounceTimer");
    this.usageRequest.cancel();
    this.usageError = null;
    // Cancel the old query's poll before it can consume this debounce and retry budget.
    this.refreshPolicy.resetPayload();
    this.routeDataEnabled = false;
    this.dateDebounceTimer = window.setTimeout(() => {
      this.dateDebounceTimer = null;
      this.refreshPolicy.request("manual");
    }, 400);
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    if (!this.gateway.connected || !this.gateway.client) {
      return;
    }
    void this.context.agents.ensureList();
    const publication = this.usagePublication;
    const usageCommitted = publication.committedAt > this.usageUpdatedAt;
    this.usageUpdatedAt = publication.updatedAt;
    if (change.identityChanged || change.becameConnected) {
      this.connectionEpoch = {};
      if (this.routeDataInitialized) {
        this.refreshPolicy.request("reconnect");
      }
    } else if (usageCommitted && this.routeDataInitialized) {
      this.refreshPolicy.request("publication");
    }
    const sessionKey =
      this.usageSelectedSessions.length === 1 ? this.usageSelectedSessions[0] : undefined;
    if (change.becameAvailable && sessionKey) {
      for (const detail of [
        this.details.timeSeries,
        this.details.sessionLogs,
        this.details.session,
      ]) {
        void detail.recover(sessionKey, detail === this.details.session);
      }
    }
  }

  private selectSession(key: string, shiftKey: boolean, orderedKeys: string[]) {
    const selectedRow = this.usageRosterResult?.sessions.find((session) => session.key === key);
    this.details.clear();
    this.display = {
      ...this.display,
      recentSessions: [key, ...this.display.recentSessions.filter((entry) => entry !== key)].slice(
        0,
        8,
      ),
    };

    this.usageSelectedSessions = toggleUsageRangeSelection(
      this.usageSelectedSessions,
      key,
      orderedKeys,
      shiftKey,
      "replace",
    );

    this.selectedSession =
      this.usageSelectedSessions.length === 1 ? (selectedRow ?? this.selectedSession) : null;
    this.refreshOverview();
    if (this.usageSelectedSessions.length === 1) {
      const sessionKey = this.usageSelectedSessions[0];
      if (sessionKey) {
        this.details.load(sessionKey);
      }
    }
  }

  private refreshOverview() {
    this.usageOffset = 0;
    void this.loadUsage();
  }

  private applyQuery() {
    this.clearDebounce("queryDebounceTimer");
    this.setFilters({ query: this.filters.queryDraft });
    this.refreshOverview();
  }

  read(): UsageProps {
    const timeSeries = this.details.timeSeries.data;
    const props: UsageProps = {
      data: {
        loading: this.usageLoading,
        exporting: this.usageExportRequest.pending,
        error: this.usageError,
        sessions: this.usageRosterResult?.sessions ?? [],
        sessionPage: this.usageRosterResult?.overview,
        creatorOptions: this.usageCreatorOptions,
        overview: this.usageResult?.overview,
        selectedSession: this.details.session.data ?? this.selectedSession,
        totals: this.usageResult?.totals ?? null,
        aggregates: this.usageResult?.aggregates ?? null,
        costDaily: this.usageCalendarSummary?.daily ?? [],
        cacheRefresh: this.usageCacheIncomplete
          ? this.usageRefreshFailed
            ? "failed"
            : "retrying"
          : "complete",
        providerUsage: this.providerUsageSummary?.providers ?? [],
        providerUsageStalled:
          this.providerUsageIncomplete && this.refreshPolicy.incompleteUsageExhausted,
        providerUsageUnavailable: this.providerUsageUnavailable,
      },
      filters: { ...this.filters, selectedSessions: this.usageSelectedSessions },
      display: this.display,
      detail: {
        context: {
          weight: this.details.session.data?.contextWeight,
          loading: this.details.session.loading,
          status: this.details.session.status,
        },
        timeSeriesMode: this.usageTimeSeriesMode,
        timeSeriesBreakdownMode: this.usageTimeSeriesBreakdownMode,
        timeSeries,
        timeSeriesLoading: this.details.timeSeries.loading,
        timeSeriesStatus: this.details.timeSeries.status,
        timeSeriesCursorStart: this.usageTimeSeriesCursorStart,
        timeSeriesCursorEnd: this.usageTimeSeriesCursorEnd,
        sessionLogs: this.details.sessionLogs.data,
        sessionLogsLoading: this.details.sessionLogs.loading,
        sessionLogsStatus: this.details.sessionLogs.status,
        sessionLogsExpanded: this.usageSessionLogsExpanded,
        logFilters: this.logFilters,
      },
      callbacks: {
        filters: {
          onDatesChange: (dates) => {
            this.setFilters(dates);
            this.scheduleUsageLoad();
          },
          onScopeChange: (scope) => {
            this.setFilters(scope);
            this.clearSelectionsAndDetails();
            this.refreshPolicy.request("manual");
          },
          onRefresh: () => {
            for (const receipt of this.usagePublication.failures) {
              this.acknowledgedUsageFailures.add(receipt);
            }
            this.refreshPolicy.request("manual");
          },
          onToggleHeaderPinned: () => {
            this.display = { ...this.display, headerPinned: !this.display.headerPinned };
            this.notify();
          },
          onSelectHour: (hour, shiftKey) => {
            this.setFilters({
              selectedHours: toggleUsageRangeSelection(
                this.filters.selectedHours,
                hour,
                Array.from({ length: 24 }, (_, index) => index),
                shiftKey,
                "append",
              ),
            });
            this.refreshOverview();
          },
          onQueryDraftChange: (query) => {
            this.setFilters({ queryDraft: query });
            this.clearDebounce("queryDebounceTimer");
            this.queryDebounceTimer = window.setTimeout(() => {
              this.queryDebounceTimer = null;
              this.applyQuery();
            }, 250);
          },
          onApplyQuery: () => {
            this.applyQuery();
          },
          onClearQuery: () => {
            this.clearDebounce("queryDebounceTimer");
            this.setFilters({ queryDraft: "", query: "" });
            this.refreshOverview();
          },
          onSelectDay: (day, shiftKey, orderedDays) => {
            this.setFilters({
              selectedDays: toggleUsageRangeSelection(
                this.filters.selectedDays,
                day,
                orderedDays,
                shiftKey,
                "toggle",
              ),
            });
            this.refreshOverview();
          },
          onClearDays: () => {
            this.setFilters({ selectedDays: [] });
            this.refreshOverview();
          },
          onClearHours: () => {
            this.setFilters({ selectedHours: [] });
            this.refreshOverview();
          },
          onClearSessions: () => {
            this.usageSelectedSessions = [];
            this.selectedSession = null;
            this.details.clear();
            this.refreshOverview();
          },
          onClearFilters: () => {
            this.clearSelectionsAndDetails();
            this.refreshOverview();
          },
        },
        display: {
          onExportJson: () => {
            void this.usageExportRequest.run("json");
          },
          onExportCsv: (format) => {
            void this.usageExportRequest.run(format);
          },
          onPageChange: (offset) => {
            this.usageOffset = offset;
            void this.loadUsage();
          },
          onChange: (next) => {
            this.display = { ...this.display, ...next };
            if (
              next.sessionSort !== undefined ||
              next.sessionSortDir !== undefined ||
              next.sessionsTab !== undefined
            ) {
              this.refreshOverview();
            }
            this.notify();
          },
        },
        details: {
          onToggleContextExpanded: () => {
            this.display = { ...this.display, contextExpanded: !this.display.contextExpanded };
            this.notify();
          },
          onToggleSessionLogsExpanded: () => {
            this.usageSessionLogsExpanded = !this.usageSessionLogsExpanded;
            this.notify();
          },
          onLogFiltersChange: (next) => {
            this.logFilters = { ...this.logFilters, ...next };
            this.notify();
          },
          onSelectSession: (key, shiftKey, orderedKeys) =>
            this.selectSession(key, shiftKey, orderedKeys),
          onTimeSeriesModeChange: (mode) => {
            this.usageTimeSeriesMode = mode;
            this.notify();
          },
          onTimeSeriesBreakdownChange: (mode) => {
            this.usageTimeSeriesBreakdownMode = mode;
            this.notify();
          },
          onTimeSeriesCursorRangeChange: (start, end) => {
            if (this.details.timeSeries.data === timeSeries) {
              this.usageTimeSeriesCursorStart = start;
              this.usageTimeSeriesCursorEnd = end;
              this.notify();
            }
          },
        },
      },
    };

    return props;
  }
}
