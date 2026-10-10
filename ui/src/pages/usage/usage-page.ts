import { consume } from "@lit/context";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
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
import { createDefaultUsageDateRange, toggleUsageRangeSelection } from "./helpers.ts";
import { renderUsagePageShell } from "./page-shell.ts";
import { UsageRefreshPolicy } from "./refresh-policy.ts";
import { type ProviderUsageSnapshot, requestUsageSnapshot } from "./request-usage-snapshot.ts";
import { createUsageRequest } from "./request.ts";
import type { UsageProps, UsageRouteData } from "./types.ts";
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
  @state() private filters: Omit<UsageProps["filters"], "selectedSessions"> = {
    ...createDefaultUsageDateRange(),
    scope: "family",
    creatorKey: null,
    selectedDays: [],
    selectedHours: [],
    query: "",
    queryDraft: "",
    timeZone: "local",
  };
  @state() private display: UsageProps["display"] = {
    chartMode: "tokens",
    dailyChartMode: "by-type",
    sessionSort: "recent",
    sessionSortDir: "desc",
    recentSessions: [],
    contextExpanded: false,
    headerPinned: false,
    sessionsTab: "all",
  };
  @state() private logFilters: UsageProps["detail"]["logFilters"] = {
    roles: [],
    tools: [],
    hasTools: false,
    query: "",
  };
  @state() private usageSelectedSessions: string[] = [];
  @state() private usageAgentId: string | null = null;
  @state() private usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() private usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeriesCursorStart: number | null = null;
  @state() private usageTimeSeriesCursorEnd: number | null = null;
  @state() private usageSessionLogsExpanded = false;

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
      this.setFilters({ creatorKey: null });
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
    .watchStore(() => this.context?.agents);

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.clearDebounce("dateDebounceTimer");
    this.clearDebounce("queryDebounceTimer");
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
      this.usageCostSummary?.cacheStatus,
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
  }

  private clearSelectionsAndDetails() {
    this.usageExportRequest.cancel();
    this.setFilters({ selectedDays: [], selectedHours: [] });
    this.usageSelectedSessions = [];
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
        this.details.contextWeight,
      ]) {
        void detail.recover(sessionKey, detail === this.details.contextWeight);
      }
    }
  }

  private selectSession(key: string, shiftKey: boolean, orderedKeys: string[]) {
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
      filters: { ...this.filters, selectedSessions: this.usageSelectedSessions },
      display: this.display,
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
          },
          onQueryDraftChange: (query) => {
            this.setFilters({ queryDraft: query });
            this.clearDebounce("queryDebounceTimer");
            this.queryDebounceTimer = window.setTimeout(() => {
              this.setFilters({ query: this.filters.queryDraft });
              this.queryDebounceTimer = null;
            }, 250);
          },
          onApplyQuery: () => {
            this.clearDebounce("queryDebounceTimer");
            this.setFilters({ query: this.filters.queryDraft });
          },
          onClearQuery: () => {
            this.clearDebounce("queryDebounceTimer");
            this.setFilters({ queryDraft: "", query: "" });
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
          },
          onClearDays: () => this.setFilters({ selectedDays: [] }),
          onClearHours: () => this.setFilters({ selectedHours: [] }),
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
          onChange: (next) => {
            this.display = { ...this.display, ...next };
          },
        },
        details: {
          onToggleContextExpanded: () => {
            this.display = { ...this.display, contextExpanded: !this.display.contextExpanded };
          },
          onToggleSessionLogsExpanded: () =>
            (this.usageSessionLogsExpanded = !this.usageSessionLogsExpanded),
          onLogFiltersChange: (next) => {
            this.logFilters = { ...this.logFilters, ...next };
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
