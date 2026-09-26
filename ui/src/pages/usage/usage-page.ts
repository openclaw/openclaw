import { consume } from "@lit/context";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isUsageIncomplete } from "../../lib/incomplete-usage-retry.ts";
import type { SessionUsageQuery } from "../../lib/sessions/usage.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { isUsageCacheIncomplete, resolveUsagePublication } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { UsageDetailsController } from "./detail-controller.ts";
import { createUsageJsonExportRequest } from "./export.ts";
import {
  createDefaultUsageDateRange,
  selectUsageSessionKeys,
  toggleUsageRangeSelection,
  toUsageErrorMessage,
} from "./helpers.ts";
import { renderUsagePageShell } from "./page-shell.ts";
import { UsageRefreshPolicy } from "./refresh-policy.ts";
import { type ProviderUsageSnapshot, requestUsageSnapshot } from "./request-usage-snapshot.ts";
import { createUsageRequest } from "./request.ts";
import type { SessionLogRole, UsageProps, UsageRouteData } from "./types.ts";
import { renderUsage } from "./view.ts";

export type { UsageRouteData } from "./types.ts";

class UsagePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: UsageRouteData;

  @state() private usageSnapshot: {
    query: SessionUsageQuery;
    result: SessionsUsageResult | null;
    costSummary: CostUsageSummary | null;
  } | null = null;
  @state() private providerUsageSummary: ProviderUsageSummary | null = null;
  @state() private providerUsageUnavailable = false;
  @state() private providerUsageIncomplete = false;
  @state() private usageError: string | null = null;
  private readonly initialDateRange = createDefaultUsageDateRange();
  @state() private usageStartDate = this.initialDateRange.startDate;
  @state() private usageEndDate = this.initialDateRange.endDate;
  @state() private usageScope: "instance" | "family" = "family";
  @state() private usageAgentId: string | null = null;
  @state() private usageCreatorKey: string | null = null;
  @state() private usageSelectedSessions: string[] = [];
  @state() private usageSelectedDays: string[] = [];
  @state() private usageSelectedHours: number[] = [];
  @state() private usageChartMode: "tokens" | "cost" = "tokens";
  @state() private usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() private usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeriesCursorStart: number | null = null;
  @state() private usageTimeSeriesCursorEnd: number | null = null;
  @state() private usageSessionLogsExpanded = false;
  @state() private usageQuery = "";
  @state() private usageQueryDraft = "";
  @state() private usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" =
    "recent";
  @state() private usageSessionSortDir: "desc" | "asc" = "desc";
  @state() private usageRecentSessions: string[] = [];
  @state() private usageTimeZone: "local" | "utc" = "local";
  @state() private usageContextExpanded = false;
  @state() private usageHeaderPinned = false;
  @state() private usageSessionsTab: "all" | "recent" = "all";
  @state() private usageLogFilterRoles: SessionLogRole[] = [];
  @state() private usageLogFilterTools: string[] = [];
  @state() private usageLogFilterHasTools = false;
  @state() private usageLogFilterQuery = "";

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
      this.clearDateDebounce();
      const sessionKey =
        reason === "manual" && this.usageSelectedSessions.length === 1
          ? this.usageSelectedSessions[0]
          : undefined;
      return this.loadUsage(sessionKey);
    },
    onIncompleteUsageExhausted: () => this.requestUpdate(),
  });
  private readonly gateway = new GatewayPageController(this, {
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
      this.usageCreatorKey = null;
      this.clearSelectionsAndDetails();
      this.refreshPolicy.request("manual");
    }
    this.requestUpdate();
  });

  private readonly usageRequest = createUsageRequest(this, {
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
        this.usageSnapshot = {
          query: value.query,
          result: snapshot.value.result,
          costSummary: snapshot.value.costSummary,
        };
        this.usageError = null;
        const sessionKey =
          this.usageSelectedSessions.length === 1 ? this.usageSelectedSessions[0] : undefined;
        if (sessionKey) {
          // Manual intent belongs to this request's selection, never a later poll or selection.
          this.details.load(sessionKey, value.refreshSessionKey === sessionKey);
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

  private readonly usageExportRequest = createUsageJsonExportRequest(
    this,
    this.gateway,
    () => this.currentQuery,
  );

  private readonly details = new UsageDetailsController(
    this,
    this.gateway,
    () => this.currentQuery,
    () => this.usageResult?.sessions ?? [],
    () => {
      this.usageTimeSeriesCursorStart = null;
      this.usageTimeSeriesCursorEnd = null;
    },
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agentSelection,
      (selection) => this.observeAgentScope(selection),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.clearDateDebounce();
    this.clearQueryDebounce();
    this.refreshPolicy.dispose();
    this.usageRequest.cancel();
    this.details.cancel();
    this.usageExportRequest.cancel();
    super.disconnectedCallback();
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

    this.usageStartDate = data.query.startDate;
    this.usageEndDate = data.query.endDate;
    this.usageScope = data.query.scope;
    this.usageTimeZone = data.query.timeZone;
    this.usageAgentId = data.query.agentId;
    this.usageCreatorKey = data.query.creatorKey ?? null;
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
    this.clearDateDebounce();
    this.usageRequest.cancel();
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.usageSnapshot = null;
    this.resetProviderUsage();
    this.usageError = null;
    this.usageAgentId = this.context.agentSelection.state.scopeId;
    this.usageCreatorKey = null;
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
      this.providerUsageIncomplete = !result.ok || isUsageIncomplete(result.value);
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
      this.usageCostSummary?.cacheStatus,
    );
  }

  private get currentQuery(): SessionUsageQuery {
    return {
      startDate: this.usageStartDate,
      endDate: this.usageEndDate,
      scope: this.usageScope,
      timeZone: this.usageTimeZone,
      agentId: normalizeLowercaseStringOrEmpty(this.usageAgentId ?? "") || undefined,
      creatorKey: this.usageCreatorKey ?? undefined,
    };
  }

  private isCurrentQuery(query: SessionUsageQuery): boolean {
    const current = this.currentQuery;
    return (
      query.startDate === current.startDate &&
      query.endDate === current.endDate &&
      query.scope === current.scope &&
      query.timeZone === current.timeZone &&
      query.agentId === current.agentId &&
      query.creatorKey === current.creatorKey
    );
  }

  private get usageResult(): SessionsUsageResult | null {
    return this.usageSnapshot && this.isCurrentQuery(this.usageSnapshot.query)
      ? this.usageSnapshot.result
      : null;
  }

  private get usageCostSummary(): CostUsageSummary | null {
    return this.usageSnapshot && this.isCurrentQuery(this.usageSnapshot.query)
      ? this.usageSnapshot.costSummary
      : null;
  }

  private get usageCreatorOptions() {
    // Keep the selector usable during a filter change, but never carry another
    // agent's identities across an agent or Gateway replacement.
    return this.usageSnapshot?.query.agentId === this.currentQuery.agentId
      ? (this.usageSnapshot?.result?.creatorOptions ?? [])
      : [];
  }

  private get providerUsageStalled(): boolean {
    return this.providerUsageIncomplete && this.refreshPolicy.incompleteUsageExhausted;
  }

  private applyUsageError(error: unknown) {
    const missingScope = isMissingOperatorReadScopeError(error);
    this.usageError = missingScope
      ? formatMissingOperatorReadScopeMessage("usage")
      : toUsageErrorMessage(error);
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

  private clearSelections() {
    this.usageSelectedDays = [];
    this.usageSelectedHours = [];
    this.usageSelectedSessions = [];
  }

  private clearSelectionsAndDetails() {
    this.usageExportRequest.cancel();
    this.clearSelections();
    this.details.clear();
  }

  private clearDateDebounce() {
    if (this.dateDebounceTimer !== null) {
      window.clearTimeout(this.dateDebounceTimer);
      this.dateDebounceTimer = null;
    }
  }

  private scheduleUsageLoad() {
    this.clearDateDebounce();
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
        this.details.contextWeight,
      ]) {
        void detail.recover(sessionKey, detail === this.details.contextWeight);
      }
    }
  }

  private clearQueryDebounce() {
    if (this.queryDebounceTimer !== null) {
      window.clearTimeout(this.queryDebounceTimer);
      this.queryDebounceTimer = null;
    }
  }

  private selectSession(key: string, shiftKey: boolean, orderedKeys: string[]) {
    this.details.clear();
    this.usageRecentSessions = [
      key,
      ...this.usageRecentSessions.filter((entry) => entry !== key),
    ].slice(0, 8);

    this.usageSelectedSessions = selectUsageSessionKeys(
      this.usageSelectedSessions,
      key,
      orderedKeys,
      shiftKey,
    );

    if (this.usageSelectedSessions.length === 1) {
      const sessionKey = this.usageSelectedSessions[0];
      if (sessionKey) {
        this.details.load(sessionKey);
      }
    }
  }

  override render() {
    const timeSeries = this.details.timeSeries.data;
    const props: UsageProps = {
      data: {
        loading: this.usageLoading,
        exporting: this.usageExportRequest.pending,
        error: this.usageError,
        sessions: this.usageResult?.sessions ?? [],
        creatorOptions: this.usageCreatorOptions,
        sessionsLimitReached: (this.usageResult?.sessions.length ?? 0) >= 1000,
        totals: this.usageResult?.totals ?? null,
        aggregates: this.usageResult?.aggregates ?? null,
        costDaily: this.usageCostSummary?.daily ?? [],
        cacheRefresh: this.usageCacheIncomplete
          ? this.usageRefreshFailed
            ? "failed"
            : "retrying"
          : "complete",
        providerUsage: this.providerUsageSummary?.providers ?? [],
        providerUsageStalled: this.providerUsageStalled,
        providerUsageUnavailable: this.providerUsageUnavailable,
      },
      filters: {
        startDate: this.usageStartDate,
        endDate: this.usageEndDate,
        scope: this.usageScope,
        selectedSessions: this.usageSelectedSessions,
        selectedDays: this.usageSelectedDays,
        selectedHours: this.usageSelectedHours,
        creatorKey: this.usageCreatorKey,
        query: this.usageQuery,
        queryDraft: this.usageQueryDraft,
        timeZone: this.usageTimeZone,
      },
      display: {
        chartMode: this.usageChartMode,
        dailyChartMode: this.usageDailyChartMode,
        sessionSort: this.usageSessionSort,
        sessionSortDir: this.usageSessionSortDir,
        recentSessions: this.usageRecentSessions,
        sessionsTab: this.usageSessionsTab,
        contextExpanded: this.usageContextExpanded,
        headerPinned: this.usageHeaderPinned,
      },
      detail: {
        context: {
          weight: this.details.contextWeight.data,
          loading: this.details.contextWeight.loading,
          status: this.details.contextWeight.status,
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
        logFilters: {
          roles: this.usageLogFilterRoles,
          tools: this.usageLogFilterTools,
          hasTools: this.usageLogFilterHasTools,
          query: this.usageLogFilterQuery,
        },
      },
      callbacks: {
        filters: {
          onStartDateChange: (date) => {
            this.usageStartDate = date;
            this.clearSelectionsAndDetails();
            this.scheduleUsageLoad();
          },
          onEndDateChange: (date) => {
            this.usageEndDate = date;
            this.clearSelectionsAndDetails();
            this.scheduleUsageLoad();
          },
          onScopeChange: (scope) => {
            this.usageScope = scope;
            this.clearSelectionsAndDetails();
            this.refreshPolicy.request("manual");
          },
          onCreatorChange: (creatorKey) => {
            this.usageCreatorKey = creatorKey;
            this.clearSelectionsAndDetails();
            this.refreshPolicy.request("manual");
          },
          onRefresh: () => {
            for (const receipt of this.usagePublication.failures) {
              this.acknowledgedUsageFailures.add(receipt);
            }
            this.refreshPolicy.request("manual");
          },
          onTimeZoneChange: (timeZone) => {
            this.usageTimeZone = timeZone;
            this.clearSelectionsAndDetails();
            this.refreshPolicy.request("manual");
          },
          onToggleHeaderPinned: () => (this.usageHeaderPinned = !this.usageHeaderPinned),
          onSelectHour: (hour, shiftKey) => {
            this.usageSelectedHours = toggleUsageRangeSelection(
              this.usageSelectedHours,
              hour,
              Array.from({ length: 24 }, (_, index) => index),
              shiftKey,
              true,
            );
          },
          onQueryDraftChange: (query) => {
            this.usageQueryDraft = query;
            this.clearQueryDebounce();
            this.queryDebounceTimer = window.setTimeout(() => {
              this.usageQuery = this.usageQueryDraft;
              this.queryDebounceTimer = null;
            }, 250);
          },
          onApplyQuery: () => {
            this.clearQueryDebounce();
            this.usageQuery = this.usageQueryDraft;
          },
          onClearQuery: () => {
            this.clearQueryDebounce();
            this.usageQueryDraft = "";
            this.usageQuery = "";
          },
          onSelectDay: (day, shiftKey, orderedDays) => {
            this.usageSelectedDays = toggleUsageRangeSelection(
              this.usageSelectedDays,
              day,
              orderedDays,
              shiftKey,
              false,
            );
          },
          onClearDays: () => (this.usageSelectedDays = []),
          onClearHours: () => (this.usageSelectedHours = []),
          onClearSessions: () => {
            this.usageSelectedSessions = [];
            this.details.clear();
          },
          onClearFilters: () => this.clearSelectionsAndDetails(),
        },
        display: {
          onExportJson: (data) => {
            void this.usageExportRequest.run(data);
          },
          onChartModeChange: (mode) => (this.usageChartMode = mode),
          onDailyChartModeChange: (mode) => (this.usageDailyChartMode = mode),
          onSessionSortChange: (sort) => (this.usageSessionSort = sort),
          onSessionSortDirChange: (direction) => (this.usageSessionSortDir = direction),
          onSessionsTabChange: (tab) => (this.usageSessionsTab = tab),
        },
        details: {
          onToggleContextExpanded: () => (this.usageContextExpanded = !this.usageContextExpanded),
          onToggleSessionLogsExpanded: () =>
            (this.usageSessionLogsExpanded = !this.usageSessionLogsExpanded),
          onLogFilterRolesChange: (roles) => {
            this.usageLogFilterRoles = roles;
          },
          onLogFilterToolsChange: (tools) => {
            this.usageLogFilterTools = tools;
          },
          onLogFilterHasToolsChange: (hasTools) => {
            this.usageLogFilterHasTools = hasTools;
          },
          onLogFilterQueryChange: (query) => {
            this.usageLogFilterQuery = query;
          },
          onLogFilterClear: () => {
            this.usageLogFilterRoles = [];
            this.usageLogFilterTools = [];
            this.usageLogFilterHasTools = false;
            this.usageLogFilterQuery = "";
          },
          onSelectSession: (key, shiftKey, orderedKeys) =>
            this.selectSession(key, shiftKey, orderedKeys),
          onTimeSeriesModeChange: (mode) => {
            this.usageTimeSeriesMode = mode;
          },
          onTimeSeriesBreakdownChange: (mode) => {
            this.usageTimeSeriesBreakdownMode = mode;
          },
          onTimeSeriesCursorRangeChange: (start, end) => {
            if (this.details.timeSeries.data === timeSeries) {
              this.usageTimeSeriesCursorStart = start;
              this.usageTimeSeriesCursorEnd = end;
            }
          },
        },
      },
    };

    return renderUsagePageShell(this.context, this.usageResult, renderUsage(props));
  }
}

if (!customElements.get("openclaw-usage-page")) {
  customElements.define("openclaw-usage-page", UsagePage);
}

export const usagePageComponent = {
  header: true,
  render: (data: UsageRouteData | undefined) =>
    html`<openclaw-usage-page .routeData=${data}></openclaw-usage-page>`,
};
