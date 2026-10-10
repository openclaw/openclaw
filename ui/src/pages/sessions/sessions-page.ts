import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { SessionDetailsController } from "../../components/session-details-controller.ts";
import { fetchSessionMenuWork } from "../../components/session-menu-work.ts";
import "../../components/session-menu.ts";
import type { SessionMenuWork } from "../../components/session-menu.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "../../components/session-workspace-recovery.runtime.ts";
import { renderSessionsHubHeader } from "../../components/sessions-hub-header.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccessRequest,
} from "../../lib/session-method-access.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";
import type { SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  filterSessionRows,
  scopedAgentParamsForSession,
  type SessionArchivedFilter,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  isPinnableUiSessionRow,
  isSubagentSessionKey,
  resolveUiConfiguredMainKey,
  scopedSessionArtifactKey,
} from "../../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../../lib/sessions/session-requests.ts";
import { searchVisibleSessionTranscripts } from "../../lib/sessions/transcript-search.ts";
import { formatPreservedWorktreesNotice } from "../../lib/sessions/worktree-preservation.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import { ensureSessionAgentIdentities, sessionAgentIdentityById } from "./agent-scope.ts";
import { SessionsPageArchive } from "./archive-actions.ts";
import { rememberSessionCustomGroup, sessionCategoryNames } from "./custom-groups.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import { SessionsPageDialog } from "./page-dialog.ts";
import { loadStoredGroupBy, saveStoredGroupBy } from "./page-state.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import type { SessionsRouteData } from "./route.ts";
import {
  reconcileSelectedSessions,
  updateSelectedSessions,
  type SessionDeleteRow,
} from "./selection.ts";
import {
  handleSessionManagementNavigationAction,
  renderSessionManagementMenu,
} from "./session-menu.ts";
import { renderSessions, type SessionsProps } from "./view.ts";

registerSessionOrganizationEnglish();

const SESSIONS_DOCS_URL = "https://docs.openclaw.ai/concepts/session";
const SESSION_SEARCH_DEBOUNCE_MS = 200;

type SessionsPageMutationResult = "completed" | "failed" | "stale";

type SessionsPageListBinding = {
  sessions: ApplicationContext["sessions"];
  query: ReturnType<typeof buildSessionsListQuery>;
  key: string;
  transcriptKey: string;
};

class SessionsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: SessionsRouteData;

  @state() private result: SessionsListResult | null = null;
  @state() private loading = false;
  @state() private refreshing = false;
  @state() private error: string | null = null;
  @state() private activeMinutes = "";
  @state() private limit = String(SESSIONS_PAGE_DEFAULT_LIMIT);
  @state() private includeGlobal = true;
  @state() private includeUnknown = false;
  @state() private statusFilter: SessionArchivedFilter = "active";
  @state() private searchQuery = "";
  @state() private transcriptSearchQuery = "";
  @state() private submittedTranscriptSearchQuery = "";
  @state() private sortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() private sortDir: "asc" | "desc" = "desc";
  @state() private groupBy: SessionsGroupBy = loadStoredGroupBy();
  @state() private page = 0;
  @state() private pageSize = 25;
  @state() private selectedSessions = new Map<string, SessionDeleteRow>();
  @state() private sessionMenu:
    | (Pick<GatewaySessionRow, "key" | "sessionId"> & { x: number; y: number })
    | null = null;
  @state() private sessionMenuWork: SessionMenuWork | null = null;
  @state() private expandedSessionKey: string | null = null;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  private deepLinkSessionKey: string | null = null;

  // Async completions belong to one context/capability/connection/scope epoch. Bump
  // before releasing locks so stale finally blocks cannot clear newer work.
  private pageEpoch = 0;
  private pluginActionLifetime = new AbortController();
  private routeDataEnabled = true;
  private appliedRouteData?: SessionsRouteData;
  private sessionMutationPending = false;
  private sessionMenuTrigger: HTMLElement | null = null;
  private listBinding?: SessionsPageListBinding;
  private unsubscribeList?: () => void;
  private listRequest?: Promise<void>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private appliedListResult: SessionsListResult | null | undefined;
  private readonly details = new SessionDetailsController(this, {
    captureScope: () => this.captureRequestScope(),
    isCurrent: (scope) => this.isRequestScopeCurrent(scope),
    row: () => this.result?.sessions.find((row) => row.key === this.expandedSessionKey),
    agentId: (row, scope) => row.agentId ?? this.sessionPathAgentId(row.key, scope.context),
  });
  private readonly inputDialog = new SessionsPageDialog((message) => {
    this.error = message;
  });
  private readonly observeAgentScope = watchAgentScope(() => {
    // Keep same-connection list serialization.
    this.retirePageOperations();
    this.resetTranscriptSearchState(this.transcriptSearchQuery);
    if (!this.deepLinkSessionKey) {
      this.page = 0;
      this.selectedSessions = new Map();
      this.routeDataEnabled = false;
      this.clearSearchTimer();
      this.bindSessionList();
    }
    this.requestUpdate();
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watchStore(() => this.context?.agentIdentity)
    .watchStore(() => this.context?.navigation)
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => this.observeAgentScope(agentSelection),
    )
    .watchStore(() => this.context?.runtimeConfig)
    .watchStore(() => this.context?.plugins);
  private readonly gatewayLifecycle = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      const retiredResult = this.listBinding?.sessions.listSnapshot(this.listBinding.query).result;
      this.resetProviderState();
      this.appliedListResult = retiredResult;
    },
    invalidateRequests: () => this.invalidatePageWork(),
  });

  private readonly transcriptSearchTask = new Task(this, {
    args: () => {
      const context = this.context;
      const snapshot = context?.gateway.snapshot;
      return [
        snapshot?.phase === "connected" ? (snapshot.client ?? null) : null,
        this.submittedTranscriptSearchQuery,
        context ?? null,
        context?.agentSelection.state.scopeId ?? null,
      ] as const;
    },
    task: async ([client, query, context, _agentScope], { signal }) => {
      if (!client || !query || !context) {
        return initialState;
      }
      const {
        sessions,
        results,
        indexing = false,
        truncated = false,
        archivedTranscriptsExcluded = 0,
      } = await searchVisibleSessionTranscripts({
        client,
        query,
        listOptions: this.sessionListOptions(context, ""),
        // Task retirement must stop later RPCs, not only hide their eventual results.
        isCurrent: () => !signal.aborted,
      });
      return { sessions, results, indexing, truncated, archivedTranscriptsExcluded };
    },
  });

  override willUpdate(changed: PropertyValues) {
    const sessions = this.context?.sessions;
    if (sessions && this.listBinding && this.listBinding.sessions !== sessions) {
      this.unsubscribeList?.();
      this.unsubscribeList = undefined;
      this.listBinding = undefined;
      this.invalidatePageWork();
      this.resetProviderState();
    }
    if (changed.has("routeData") || changed.has("context")) {
      this.applyRouteData();
    }
    this.bindSessionList();
    this.details.synchronize();
  }

  override disconnectedCallback() {
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.listBinding = undefined;
    this.subscriptions.clear();
    this.invalidatePageWork();
    // Dialogs mount on document.body, so navigating away would otherwise leave
    // one over the destination, still submitting against this detached page.
    this.inputDialog.abort();
    super.disconnectedCallback();
  }

  private retirePageOperations() {
    this.details.reset();
    this.pluginActionLifetime.abort();
    this.pluginActionLifetime = new AbortController();
    this.pageEpoch += 1;
    this.sessionMutationPending = false;
    this.closeSessionMenu();
  }

  private invalidatePageWork() {
    this.retirePageOperations();
    this.clearSearchTimer();
    this.listRequest = undefined;
    this.resetTranscriptSearchState(this.transcriptSearchQuery);
    this.loading = false;
    this.refreshing = false;
  }

  private resetProviderState() {
    this.result = null;
    this.error = null;
    this.loading = false;
    this.refreshing = false;
    this.resetTranscriptSearchState("");
    this.selectedSessions = new Map();
    this.expandedSessionKey = null;
    this.deepLinkSessionKey = null;
    this.appliedListResult = undefined;
  }

  private readonly archiveActions = new SessionsPageArchive({
    captureScope: () => this.captureRequestScope(),
    isCurrent: (scope) => this.isRequestScopeCurrent(scope),
    publishError: (scope, error) => this.publishRequestError(scope, error),
    refresh: (scope) => this.refreshSessionList(scope),
    agentId: (key, context) => this.sessionAgentId(key, context),
    patch: (key, patch, scope, expectedId, options) =>
      this.patchSession(key, patch, scope, expectedId, options),
  });

  private captureRequestScope(): SessionsPageRequestScope | null {
    const context = this.context;
    if (!this.isConnected || !context) {
      return null;
    }
    const gateway = context.gateway;
    const client = this.gatewayLifecycle.gateway === gateway ? this.gatewayLifecycle.client : null;
    if (!this.gatewayLifecycle.connected || !client) {
      return null;
    }
    return {
      epoch: this.pageEpoch,
      signal: this.pluginActionLifetime.signal,
      context,
      gateway,
      sessions: context.sessions,
      client,
    };
  }

  private isRequestScopeCurrent(scope: SessionsPageRequestScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.isConnected &&
      this.pageEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  private publishRequestError(scope: SessionsPageRequestScope, error: unknown): "failed" | "stale" {
    if (!this.isRequestScopeCurrent(scope)) {
      return "stale";
    }
    this.error = formatUiError(error);
    return "failed";
  }

  private mutationDisabledReason(request: SessionMethodAccessRequest): string | undefined {
    const access = readSessionMethodAccess(this.context?.gateway.snapshot, request);
    return access.allowed ? undefined : access.reason;
  }

  private requireMutationAccess(
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ): boolean {
    const access = readSessionMethodAccess(scope.gateway.snapshot, request);
    if (access.allowed) {
      return true;
    }
    this.error = access.reason;
    return false;
  }

  private selectedDeleteDisabledReason(): string | undefined {
    for (const row of this.selectedSessions.values()) {
      const reason = this.mutationDisabledReason({
        method: "sessions.delete",
        params: {
          key: row.key,
          ...(row.archived === true ? { archivedOnly: true } : {}),
        },
      });
      if (reason) {
        return reason;
      }
    }
    return undefined;
  }

  private applyRouteData() {
    const data = this.routeData;
    const context = this.context;
    if (!data || !context) {
      return;
    }
    if (data !== this.appliedRouteData) {
      this.appliedRouteData = data;
      this.routeDataEnabled = true;
    }
    if (!this.routeDataEnabled) {
      return;
    }
    this.statusFilter = data.statusFilter;
    this.activeMinutes = "";
    this.limit = String(SESSIONS_PAGE_DEFAULT_LIMIT);
    this.includeGlobal = true;
    this.includeUnknown = Boolean(data.expandedSessionKey);
    if (data.expandedSessionKey) {
      this.searchQuery = "";
      this.page = 0;
      this.selectedSessions = new Map();
    }
    this.expandedSessionKey = data.expandedSessionKey;
    // Only route-driven expansion narrows the list query; interactive drawer
    // opens must keep loading the full roster (see sessionListOptions).
    this.deepLinkSessionKey = data.expandedSessionKey;
  }

  private sessionAgentId(
    key: string,
    context: ApplicationContext | undefined = this.context,
  ): string | undefined {
    if (!context) {
      return undefined;
    }
    const { agentId } = scopedAgentParamsForSession(
      {
        assistantAgentId: context.agentSelection.state.selectedId,
        hello: context.gateway.snapshot.hello,
      },
      key,
    );
    return agentId;
  }

  private sessionPathAgentId(key: string, context: ApplicationContext): string {
    return this.sessionAgentId(key, context) ?? resolveSessionNavigationAgentId(context);
  }

  private sessionListOptions(context: ApplicationContext, search = this.searchQuery) {
    return buildSessionsListQuery(context, {
      activeMinutes: parseStrictPositiveInteger(this.activeMinutes),
      // The Limit box is an explicit page size, so an unparseable entry falls
      // back to the page default rather than to the shared roster page size.
      limit: parseStrictPositiveInteger(this.limit) ?? SESSIONS_PAGE_DEFAULT_LIMIT,
      includeGlobal: this.includeGlobal,
      includeUnknown: this.includeUnknown,
      statusFilter: this.statusFilter,
      deepLinkSessionKey: this.deepLinkSessionKey,
      search,
    });
  }

  private bindSessionList(refreshMissing = true): SessionsPageListBinding | undefined {
    const context = this.context;
    if (!context || !this.isConnected) {
      return undefined;
    }
    const sessions = context.sessions;
    const query = this.sessionListOptions(context);
    const key = JSON.stringify(query);
    const current = this.listBinding;
    const transcriptKey = JSON.stringify(this.sessionListOptions(context, ""));
    if (current?.sessions !== sessions || current.key !== key) {
      // An event refresh can already own the old query's request.
      if (current?.sessions === sessions && sessions.listSnapshot(current.query).loading) {
        void this.loadSessionList(current);
      }
      this.unsubscribeList?.();
      this.unsubscribeList = undefined;
      if (current?.sessions !== sessions || current.transcriptKey !== transcriptKey) {
        this.resetTranscriptSearchState(this.transcriptSearchQuery);
      }
      // Retired rows cannot be selected under replacement text, even during debounce.
      this.result = null;
      this.error = null;
      this.selectedSessions = new Map();
      this.page = 0;
      this.listBinding = { sessions, query, key, transcriptKey };
      this.appliedListResult = undefined;
    }
    const binding = this.listBinding!;
    if (this.unsubscribeList) {
      return binding;
    }
    this.loading = context.gateway.snapshot.phase === "connected";
    if (!this.captureRequestScope() || this.searchTimer !== undefined || this.listRequest) {
      return binding;
    }
    const apply = (snapshot: SessionListSnapshot) => {
      this.applyListSnapshot(binding, snapshot);
    };
    this.unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (refreshMissing && (!snapshot.result || snapshot.loading)) {
      void this.loadSessionList(binding);
    }
    return binding;
  }

  private applyListSnapshot(binding: SessionsPageListBinding, snapshot: SessionListSnapshot) {
    if (this.listBinding !== binding || this.context?.sessions !== binding.sessions) {
      return;
    }
    this.loading = snapshot.loading;
    this.error = snapshot.error;
    const result = snapshot.result;
    if (!result) {
      return;
    }
    if (result !== this.appliedListResult) {
      this.appliedListResult = result;
      this.result = filterSessionRows(result, { archivedFilter: this.statusFilter });
      ensureSessionAgentIdentities(this.context?.agentIdentity, this.result);
    }
    if (!snapshot.loading && !snapshot.error && this.result && this.selectedSessions.size > 0) {
      this.selectedSessions = reconcileSelectedSessions(
        this.selectedSessions,
        this.result.sessions,
        (row) =>
          binding.sessions.deletionState(row.key, this.sessionAgentId(row.key), row.sessionId) ===
            "pending" || binding.sessions.archiveVisibility(row.key) === "pending",
      );
    }
  }

  private async refreshSessionList(scope = this.captureRequestScope()) {
    if (!scope) {
      return;
    }
    this.routeDataEnabled = false;
    this.clearSearchTimer();
    const binding = this.bindSessionList(false);
    if (!binding || binding.sessions !== scope.sessions || !this.isRequestScopeCurrent(scope)) {
      return;
    }
    await this.loadSessionList(binding, { force: true });
    if (this.isRequestScopeCurrent(scope) && this.listBinding === binding) {
      this.applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
    }
  }

  private loadSessionList(
    binding: SessionsPageListBinding,
    options: { force?: boolean; offset?: number; append?: boolean } = {},
  ): Promise<void> {
    if (this.listRequest) {
      // Only the bound query may queue mutation invalidation in its managed owner.
      if (options.force && this.unsubscribeList) {
        void binding.sessions.refreshList({ ...binding.query, ...options });
      }
      return this.listRequest;
    }
    if (!this.captureRequestScope()) {
      return Promise.resolve();
    }
    // Claim before refreshList publishes. Only this connection's completion may
    // release the slot; the next query is read from page state, never queued here.
    const completion = createDeferredCore();
    const pending = completion.promise.finally(() => {
      if (this.listRequest !== pending) {
        return;
      }
      this.listRequest = undefined;
      this.refreshing = false;
      this.bindSessionList();
    });
    this.listRequest = pending;
    this.refreshing = true;
    completion.resolve(binding.sessions.refreshList({ ...binding.query, ...options }));
    return pending;
  }

  private clearSearchTimer() {
    clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
  }

  private resetTranscriptSearchState(query: string) {
    this.transcriptSearchQuery = query;
    this.submittedTranscriptSearchQuery = "";
    void this.transcriptSearchTask.run();
  }

  private updateTranscriptSearchQuery(query: string) {
    if (query === this.transcriptSearchQuery) {
      return;
    }
    // Editing invalidates the visible results and the in-flight query so a
    // late response cannot appear under different search text.
    this.resetTranscriptSearchState(query);
  }

  private async runTranscriptSearch() {
    const query = this.transcriptSearchQuery.trim();
    if (!query) {
      this.resetTranscriptSearchState("");
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    this.transcriptSearchQuery = query;
    this.submittedTranscriptSearchQuery = query;
    await this.transcriptSearchTask.run();
  }

  private updateFilters(next: Parameters<SessionsProps["onFiltersChange"]>[0]) {
    this.activeMinutes = next.activeMinutes;
    this.limit = next.limit;
    this.includeGlobal = next.includeGlobal;
    this.includeUnknown = next.includeUnknown;
    this.page = 0;
    this.selectedSessions = new Map();
    // Explicit filter edits leave deep-link mode; load the full roster.
    this.deepLinkSessionKey = null;
    void this.refreshSessionList();
  }

  private updateStatusFilter(statusFilter: SessionArchivedFilter) {
    const context = this.context;
    if (statusFilter === this.statusFilter || !context) {
      return;
    }
    this.statusFilter = statusFilter;
    this.clearSearchTimer();
    this.page = 0;
    this.selectedSessions = new Map();
    this.deepLinkSessionKey = null;
    // Route navigation changes the managed query; mask the old view's rows
    // until its current list subscription publishes.
    this.loading = true;
    this.error = null;
    context.navigate(
      "sessions",
      statusFilter === "active" ? undefined : { search: `?status=${statusFilter}` },
    );
  }

  private updateSelection(keys: string[], mode: "select" | "toggle" | "deselect") {
    this.selectedSessions = updateSelectedSessions(
      this.selectedSessions,
      this.result?.sessions ?? [],
      keys,
      mode,
    );
  }

  private async deleteSelected() {
    const rows = [...this.selectedSessions.values()];
    if (rows.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const message = t(
      rows.length === 1
        ? "sessionsView.deleteSelectedConfirmOne"
        : "sessionsView.deleteSelectedConfirm",
      { count: String(rows.length) },
    );
    if (!(await this.confirmMutation(message)) || !this.isRequestScopeCurrent(scope)) {
      return;
    }
    await this.deleteSessions(rows.filter((row) => this.selectedSessions.get(row.key) === row));
  }

  private confirmMutation(
    message: string,
    options: { confirmLabel?: string; signal?: AbortSignal } = {},
  ) {
    return showConfirmDialog({
      message,
      confirmLabel: t("common.delete"),
      danger: true,
      signal: this.pluginActionLifetime.signal,
      ...options,
    });
  }

  private async deleteSessions(
    rows: SessionDeleteRow[],
    options: { deleteTranscript?: boolean } = {},
  ) {
    if (rows.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const requests = rows.map((row) => ({
      key: row.key,
      agentId: this.sessionAgentId(row.key, scope.context),
      ...options,
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.archived === true ? { archivedOnly: true } : {}),
    }));
    for (const params of requests) {
      if (!this.requireMutationAccess(scope, { method: "sessions.delete", params })) {
        return;
      }
    }
    await this.runSessionMutation(scope, async () => {
      const request = async () => {
        const result = await scope.sessions.deleteMany(requests);
        if (rows.length === 1 && result.errors.length > 0) {
          throw result.errors[0]!.error;
        }
        return result;
      };
      const row = rows[0]!;
      const result =
        rows.length === 1
          ? await withSessionWorkspaceRecovery({
              action: "delete",
              session: {
                ...row,
                label: row.label || row.displayName || row.key,
                agentId: requests[0]!.agentId,
              },
              scope,
              isCurrent: () => this.isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (!this.isRequestScopeCurrent(scope) || !result) {
        return undefined;
      }
      if (result.preservedWorktrees.length > 0) {
        window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
      }
      if (result.deleted.length > 0) {
        const deleted = new Set(result.deleted);
        const selected = new Map(this.selectedSessions);
        for (const key of result.deleted) {
          selected.delete(key);
        }
        this.selectedSessions = selected;
        if (this.expandedSessionKey && deleted.has(this.expandedSessionKey)) {
          this.expandedSessionKey = null;
        }
        if (this.deepLinkSessionKey && deleted.has(this.deepLinkSessionKey)) {
          this.deepLinkSessionKey = null;
        }
        const deletedCurrent = result.deleted.find((key) =>
          areUiSessionKeysEquivalent(key, scope.gateway.snapshot.sessionKey),
        );
        if (deletedCurrent) {
          const agentId =
            parseAgentSessionKey(deletedCurrent)?.agentId ??
            scope.context.agentSelection.state.selectedId ??
            "main";
          selectApplicationSession({
            selection: scope.context.agentSelection,
            gateway: scope.gateway,
            agentId,
            sessionKey: buildAgentMainSessionKey({
              agentId,
              mainKey: resolveUiConfiguredMainKey({
                agentsList: scope.context.agents.state.agentsList,
                hello: scope.gateway.snapshot.hello,
              }),
            }),
          });
        }
      }
      await this.refreshSessionList(scope);
      return result.errors.length > 0
        ? result.errors.map(({ error }) => formatBatchSessionRemovalError(error)).join("; ")
        : undefined;
    });
  }

  private async deleteAllArchived() {
    const scope = this.captureRequestScope();
    if (!scope || this.loading || this.sessionMutationPending) {
      return;
    }
    // The rendered list is bounded by the page's limit filter; re-enumerate the
    // full archived set so "all archived" means all of them. Any abnormal page
    // (failure, non-advancing offset) aborts: deleting a partial enumeration
    // would silently violate the "all archived" contract.
    let rows: GatewaySessionRow[];
    try {
      // One options snapshot for every page: filter edits made while pages load
      // must not mix populations; a deep link never narrows "all archived".
      const {
        search: _deepLinkSearch,
        agentId: _linkedAgentId,
        ...filters
      } = this.sessionListOptions(scope.context);
      const agentId = scope.context.agentSelection.state.scopeId?.trim();
      const listOptions = { ...filters, ...(agentId ? { agentId } : {}) };
      const listed = await fetchPagedSessionRows({
        list: (offset) => scope.sessions.list({ ...listOptions, limit: 1000, offset }),
        isCurrent: () => this.isRequestScopeCurrent(scope),
        missingResultError:
          scope.sessions.state.error ?? "archived session enumeration returned no result",
        stalledPaginationError: "archived session enumeration did not advance",
        incompletePaginationError: "archived session enumeration was incomplete",
      });
      if (!listed) {
        return;
      }
      rows = listed;
    } catch (error) {
      this.publishRequestError(scope, error);
      return;
    }
    const archivedRows = rows.filter((row) => row.archived === true);
    if (archivedRows.length === 0) {
      return;
    }
    if (
      !(await this.confirmMutation(
        t("sessionsView.deleteAllArchivedConfirm", {
          count: String(archivedRows.length),
        }),
        { signal: scope.signal },
      )) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await this.deleteSessions(archivedRows, { deleteTranscript: true });
  }

  private async deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await this.confirmMutation(t("sessionsView.deleteSessionConfirm", { session: label }))) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await this.deleteSessions([row]);
  }

  private async stopCloudWorker(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const stopAction = resolveCloudWorkerStopAction(row.placement);
    if (!stopAction || (stopAction.blocksActiveRun && row.hasActiveRun === true)) {
      return;
    }
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await this.confirmMutation(t("sessionsView.stopCloudWorkerConfirm", { session: label }), {
        confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
      })) ||
      !this.isRequestScopeCurrent(scope) ||
      !this.requireMutationAccess(scope, stopAction)
    ) {
      return;
    }
    await this.runSessionMutation(scope, async () => {
      const agentId = parseAgentSessionKey(row.key)?.agentId;
      await requestCloudWorkerStop(
        scope.client,
        {
          key: row.key,
          ...(agentId ? { agentId } : {}),
        },
        scope.context.placementStartup,
      );
      if (this.isRequestScopeCurrent(scope)) {
        await this.refreshSessionList(scope);
      }
    });
  }

  private async runSessionMutation(
    scope: SessionsPageRequestScope,
    mutate: () => Promise<string | void>,
  ) {
    this.sessionMutationPending = true;
    let mutationError: string | void = undefined;
    try {
      mutationError = await mutate();
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        mutationError = formatUiError(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope)) {
        this.sessionMutationPending = false;
        const binding = this.listBinding;
        if (binding) {
          this.applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
        }
        if (mutationError) {
          this.error = mutationError;
        }
      }
    }
  }

  private knownCategories(): string[] {
    return sessionCategoryNames(this.result, this.context?.sessions.state.groups ?? []);
  }

  private async rememberCustomGroup(
    name: string,
    scope: SessionsPageRequestScope | null = this.captureRequestScope(),
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      return "stale";
    }
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      })
    ) {
      return "failed";
    }
    return rememberSessionCustomGroup({
      name,
      knownCategories: this.knownCategories(),
      sessions: scope.sessions,
      isCurrent: () => this.isRequestScopeCurrent(scope),
      onError: (message) => {
        this.error = message;
      },
    });
  }

  private assignCategory(key: string, category: string | null) {
    // Only patch keys that exist in the current result; sessions.patch would
    // otherwise create a store entry for arbitrary dropped text.
    const session = this.result?.sessions.find((row) => row.key === key);
    if (!session) {
      return;
    }
    // Dropping a row onto its own section is a no-op; skip the patch round-trip.
    const current = session.category?.trim() || null;
    const promote = !isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session);
    if (current === category && !promote) {
      return;
    }
    if (category) {
      void this.rememberCustomGroup(category);
    }
    void this.patchSession(
      key,
      { category, ...(promote ? { sidebarRoot: true } : {}) },
      undefined,
      session.sessionId,
    );
  }

  private async requestNewCategory(sessionKey?: string) {
    // Capture before loading the dialog: its key may belong to a replacement
    // by the time the operator submits or the catalog write completes.
    const session = this.result?.sessions.find((row) => row.key === sessionKey);
    if (sessionKey && !session?.sessionId) {
      this.error = t("common.refresh");
      return;
    }
    await this.inputDialog.open(() => ({
      title: t("sessionsView.newGroupTitle"),
      label: t("sessionsView.newGroupPrompt"),
      submitLabel: t("sessionsView.newGroupCreate"),
      requireValue: true,
      submit: (name) => this.writeNewCategory(name, session),
    }));
  }

  /**
   * One captured scope covers both writes: the catalog entry lands before the
   * row moves, and a catalog write that outlived its connection must not be
   * followed by an assignment issued on the replacement one.
   */
  private async writeNewCategory(
    name: string,
    session?: GatewaySessionRow,
  ): Promise<string | null> {
    this.error = null;
    const scope = this.captureRequestScope();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const remembered = await this.rememberCustomGroup(name, scope);
    if (remembered !== "completed") {
      return remembered === "failed"
        ? (this.error ?? t("sessionsView.newGroupFailed"))
        : t("sessionsView.newGroupStale");
    }
    if (!session) {
      return null;
    }
    const assigned = await this.patchSession(
      session.key,
      {
        category: name,
        ...(!isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session)
          ? { sidebarRoot: true }
          : {}),
      },
      scope,
      session.sessionId,
    );
    if (assigned === "failed") {
      return this.error ?? t("sessionsView.newGroupFailed");
    }
    return assigned === "stale" ? t("sessionsView.newGroupStale") : null;
  }

  private async renameSession(row: GatewaySessionRow) {
    const scope = this.captureRequestScope();
    if (!scope) {
      this.error = t("sessionsView.actionRequiresConnection");
      return;
    }
    const initialValue = resolveSessionRenameValue(row);
    const value = await this.inputDialog.open(() => ({
      signal: scope.signal,
      title: t("sessionsView.renameSessionPrompt"),
      defaultValue: initialValue,
    }));
    if (value === null || !this.isRequestScopeCurrent(scope)) {
      return;
    }
    const patch = resolveSessionRenamePatch(value, initialValue, row.label);
    if (patch) {
      await this.patchSession(row.key, patch, scope, row.sessionId, { sessionScope: true });
    }
  }

  private async patchSession(
    key: string,
    patch: Parameters<SessionsProps["onPatch"]>[1],
    scope: SessionsPageRequestScope | null = this.captureRequestScope(),
    expectedSessionId?: string,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean } = {},
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      // Nothing was attempted (e.g. rename dialog submitted after the gateway
      // dropped); say so instead of silently swallowing the edit.
      this.error = t("sessionsView.actionRequiresConnection");
      return "failed";
    }
    if (typeof patch.archived === "boolean" && !expectedSessionId?.trim()) {
      this.error = "Session lifecycle action requires a durable session identity.";
      return "failed";
    }
    const agentId = this.sessionAgentId(key, scope.context);
    const row = this.result?.sessions.find((entry) => entry.key === key);
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.patch",
        sessionScope: options.sessionScope,
        session: row,
        params: {
          key,
          ...patch,
          ...(agentId ? { agentId } : {}),
        },
      })
    ) {
      return "failed";
    }
    try {
      const request = () =>
        scope.sessions.patch(key, patch, {
          agentId,
          ...(expectedSessionId ? { expectedSessionId } : {}),
        });
      const patched =
        patch.archived === true
          ? await withSessionWorkspaceRecovery({
              action: "archive",
              session: {
                key,
                sessionId: expectedSessionId,
                label: row?.label || row?.displayName || key,
                agentId,
              },
              scope,
              isCurrent: () => this.isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (patched) {
        options.onConfirmed?.(patched);
      }
      if (!this.isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        this.error = scope.sessions.state.error;
        return "failed";
      }
      await this.refreshSessionList(scope);
      if (!this.isRequestScopeCurrent(scope)) {
        return "stale";
      }
      const selected = new Map(this.selectedSessions);
      selected.delete(key);
      this.selectedSessions = selected;
      return "completed";
    } catch (error) {
      return this.publishRequestError(scope, error);
    }
  }

  private async forkSession(key: string, fromLastCompleted = false) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = this.sessionAgentId(key, scope.context);
    const createParams = {
      parentSessionKey: key,
      fork: true,
      ...(fromLastCompleted ? { forkFrom: "last-completed" as const } : {}),
      ...(agentId ? { agentId } : {}),
    };
    if (!this.requireMutationAccess(scope, { method: "sessions.create", params: createParams })) {
      return;
    }
    try {
      const forkedKey = await scope.sessions.create(createParams);
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      if (forkedKey) {
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: forkedKey,
            agentId: agentId ?? this.sessionPathAgentId(forkedKey, scope.context),
          }).options,
          hash: "",
        });
      } else if (scope.sessions.state.error) {
        this.error = scope.sessions.state.error;
      }
    } catch (error) {
      this.publishRequestError(scope, error);
    }
  }

  private openSessionMenu(
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (
      this.sessionMenu?.key === row.key &&
      this.sessionMenu.sessionId === row.sessionId &&
      trigger
    ) {
      this.closeSessionMenu();
      return;
    }
    this.sessionMenu = { key: row.key, sessionId: row.sessionId, ...position };
    this.sessionMenuTrigger = trigger;
    this.loadSessionMenuWork(row);
  }

  private closeSessionMenu() {
    if (this.context) {
      sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    }
    this.sessionMenu = null;
    this.sessionMenuTrigger = null;
    this.sessionMenuWork = null;
  }

  private loadSessionMenuWork(row: GatewaySessionRow) {
    // Every opening has its own identity, including reopening the same row.
    const menu = this.sessionMenu;
    if (!row.worktree) {
      this.sessionMenuWork = null;
      return;
    }
    this.sessionMenuWork = { loading: true, pullRequestUrl: null, worktreePath: null };
    const scope = this.captureRequestScope();
    if (!scope) {
      this.sessionMenuWork = { loading: false, pullRequestUrl: null, worktreePath: null };
      return;
    }
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionArtifactKey(
      row.key,
      this.sessionAgentId(row.key, scope.context),
    );
    void fetchSessionMenuWork({
      client: scope.client,
      loadPullRequests: canCallGatewayMethod(
        scope.context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(this, pullRequestKey)
        : undefined,
      worktreeId: row.worktree.id,
      execNode: row.execNode,
    }).then((work) => {
      if (this.sessionMenu === menu) {
        this.sessionMenuWork = { loading: false, ...work };
      }
    });
  }

  private renderSessionMenu() {
    const menu = this.sessionMenu;
    const context = this.context;
    const row = menu
      ? this.result?.sessions.find(
          (session) => session.key === menu.key && session.sessionId === menu.sessionId,
        )
      : null;
    if (!menu || !context || !row) {
      return nothing;
    }
    return renderSessionManagementMenu({
      context,
      row,
      menu,
      trigger: this.sessionMenuTrigger,
      disabled: this.loading,
      groups: this.knownCategories(),
      work: this.sessionMenuWork,
      onClose: () => this.closeSessionMenu(),
      onAction: (requestedAction) => {
        const action = handleSessionManagementNavigationAction(requestedAction, {
          context,
          row,
          isCurrent: () => this.isConnected && this.context === context,
        });
        if (!action) {
          return;
        }
        switch (action.kind) {
          case "toggle-pin":
            togglePinnedSession(context.navigation, row.key);
            break;
          case "toggle-involving-me": {
            const scope = this.captureRequestScope();
            if (!scope || !row.sessionId) {
              this.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            void requestSessionInvolvement(scope.client, {
              key: row.key,
              expectedSessionId: row.sessionId,
              agentId: row.agentId ?? this.sessionAgentId(row.key, scope.context),
              hidden: !row.hiddenFromInvolvingMe,
            })
              .then(async () => {
                if (this.isRequestScopeCurrent(scope)) {
                  await this.refreshSessionList(scope);
                }
              })
              .catch((error: unknown) => this.publishRequestError(scope, error));
            break;
          }
          case "toggle-unread":
            void this.patchSession(row.key, { unread: row.unread !== true });
            break;
          case "rename":
            void this.renameSession(row);
            break;
          case "set-color":
            void this.patchSession(row.key, { color: action.color });
            break;
          case "set-icon":
            void this.patchSession(row.key, { icon: action.icon });
            break;
          case "set-communication":
            void this.patchSession(
              row.key,
              { communication: action.communication },
              undefined,
              row.sessionId,
            );
            break;
          case "reset-appearance":
            void this.patchSession(row.key, { icon: null, color: null });
            break;
          case "fork":
            void this.forkSession(row.key, row.hasActiveRun === true);
            break;
          case "plugin":
            void this.runPluginAction(action.id, menu);
            break;
          case "move-to-top-level":
            void this.patchSession(row.key, { sidebarRoot: true }, undefined, row.sessionId, {
              sessionScope: true,
            });
            break;
          case "archive-tree":
            void this.archiveActions.archiveTree(row);
            break;
          case "move-to-group":
            this.assignCategory(row.key, action.category);
            break;
          case "new-group":
            void this.requestNewCategory(row.key);
            break;
          case "toggle-archived":
            if (row.archived === true) {
              void this.patchSession(row.key, { archived: false }, undefined, row.sessionId, {
                sessionScope: true,
              });
            } else {
              void this.archiveActions.archive(row);
            }
            break;
          case "assign-owner": {
            const scope = this.captureRequestScope();
            if (!scope) {
              this.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            if (
              !this.requireMutationAccess(scope, {
                method: "sessions.assignOwner",
                params: { key: row.key, owner: action.owner },
                requiredScope: "operator.write",
              })
            ) {
              break;
            }
            void this.runSessionMutation(scope, async () => {
              const assigned = await scope.sessions.assignOwner(row.key, action.owner);
              return assigned || !this.isRequestScopeCurrent(scope)
                ? undefined
                : (scope.sessions.state.error ?? undefined);
            });
            break;
          }
          case "stop-cloud-worker":
            void this.stopCloudWorker(row);
            break;
          case "delete":
            void this.deleteSessionFromMenu(row);
            break;
        }
      },
    });
  }

  override render() {
    const context = this.context;
    const personGroupingAvailable = (this.result?.owners?.length ?? 0) > 1;
    if (!context) {
      return html``;
    }
    return html`
      ${renderSessionsHubHeader({
        active: "sessions",
        title: titleForRoute("sessions"),
        subtitle: html`${subtitleForRoute("sessions")} ${renderLearnMoreLink(SESSIONS_DOCS_URL)}`,
        actions: renderAgentScopeControl({
          agents: context.agents.state.agentsList?.agents ?? [],
          selection: context.agentSelection,
        }),
        onSelect: (tab) => {
          if (tab !== "sessions") {
            context.navigate(tab);
          }
        },
      })}
      ${renderSettingsWorkspace(
        renderSessions({
          loading: this.loading || this.details.loading,
          refreshing: this.refreshing,
          result: this.result,
          error: this.details.error ?? this.error,
          activeMinutes: this.activeMinutes,
          limit: this.limit,
          includeGlobal: this.includeGlobal,
          includeUnknown: this.includeUnknown,
          statusFilter: this.statusFilter,
          basePath: context.basePath,
          agentId: resolveSessionNavigationAgentId(context),
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
          searchQuery: this.searchQuery,
          transcriptSearchAvailable: context.gateway.snapshot.phase === "connected",
          transcriptSearchQuery: this.transcriptSearchQuery,
          transcriptSearch: this.transcriptSearchTask.render({
            initial: () => ({ status: "idle" }) as const,
            pending: () => ({ status: "loading" }) as const,
            complete: (result) => ({ status: "results", ...result }) as const,
            error: (error) => ({ status: "error", message: formatUiError(error) }) as const,
          }),
          agentIdentityById: sessionAgentIdentityById(
            this.result,
            (agentId) => context.agentIdentity.get(agentId) ?? undefined,
          ),
          sortColumn: this.sortColumn,
          sortDir: this.sortDir,
          // Same reconnect resilience as the sidebar: the stored Person
          // preference survives a temporarily unavailable owner roster.
          groupBy: personGroupingAvailable || this.groupBy !== "person" ? this.groupBy : "none",
          personGroupingAvailable,
          knownCategories: this.knownCategories(),
          page: this.page,
          pageSize: this.pageSize,
          selectedKeys: new Set(this.selectedSessions.keys()),
          sessionMenu: this.sessionMenu,
          expandedSessionKey: this.expandedSessionKey,
          labelDisabledReason: (row) =>
            this.mutationDisabledReason({
              method: "sessions.patch",
              params: { key: row.key, label: null },
              sessionScope: true,
              session: row,
            }),
          patchAdminDisabledReason: this.mutationDisabledReason({
            method: "sessions.patch",
            params: { key: "", thinkingLevel: null },
          }),
          groupWriteDisabledReason: this.mutationDisabledReason({
            method: "sessions.groups.put",
            requiredScope: "operator.write",
          }),
          deleteArchivedDisabledReason: this.mutationDisabledReason({
            method: "sessions.delete",
            params: { key: "", archivedOnly: true, deleteTranscript: true },
          }),
          deleteSelectedDisabledReason: this.selectedDeleteDisabledReason(),
          onFiltersChange: (next) => this.updateFilters(next),
          onClearFilters: () => {
            this.searchQuery = "";
            this.updateFilters({
              activeMinutes: "",
              limit: String(SESSIONS_PAGE_DEFAULT_LIMIT),
              includeGlobal: true,
              includeUnknown: false,
            });
          },
          onSearchChange: (query) => {
            this.routeDataEnabled = false;
            this.deepLinkSessionKey = null;
            this.searchQuery = query;
            this.page = 0;
            this.selectedSessions = new Map();
            this.clearSearchTimer();
            if (this.captureRequestScope()) {
              this.searchTimer = setTimeout(() => {
                this.searchTimer = undefined;
                this.bindSessionList();
              }, SESSION_SEARCH_DEBOUNCE_MS);
            }
            this.bindSessionList();
          },
          onTranscriptSearchChange: (query) => this.updateTranscriptSearchQuery(query),
          onTranscriptSearch: () => void this.runTranscriptSearch(),
          onClearTranscriptSearch: () => this.resetTranscriptSearchState(""),
          onSortChange: (column, direction) => {
            this.sortColumn = column;
            this.sortDir = direction;
            this.page = 0;
          },
          onGroupByChange: (mode) => {
            this.groupBy = mode;
            this.page = 0;
            saveStoredGroupBy(mode);
          },
          onAssignCategory: (key, category) => this.assignCategory(key, category),
          onRequestNewCategory: (sessionKey) => void this.requestNewCategory(sessionKey),
          onLoadMore: () => {
            const binding = this.listBinding;
            const offset = this.result?.nextOffset;
            if (binding && this.result?.hasMore && offset != null && !this.loading) {
              void this.loadSessionList(binding, { offset, append: true });
            }
          },
          onPageChange: (page) => {
            this.page = page;
          },
          onPageSizeChange: (pageSize) => {
            this.pageSize = pageSize;
            this.page = 0;
          },
          onRefresh: () => void this.refreshSessionList(),
          onStatusFilterChange: (statusFilter) => this.updateStatusFilter(statusFilter),
          onDeleteAllArchived: () => void this.deleteAllArchived(),
          onPatch: (key, patch, options) =>
            void this.patchSession(key, patch, undefined, undefined, options),
          onToggleSelect: (key) => this.updateSelection([key], "toggle"),
          onSelectPage: (keys) => this.updateSelection(keys, "select"),
          onDeselectPage: (keys) => this.updateSelection(keys, "deselect"),
          onDeselectAll: () => {
            this.selectedSessions = new Map();
          },
          onDeleteSelected: () => void this.deleteSelected(),
          onNavigateToChat: (sessionKey) => {
            const face = resolveSessionPreferredFaceForKey(context, sessionKey);
            const target = sessionNavigationTarget({
              context,
              face,
              sessionKey,
              agentId: this.sessionPathAgentId(sessionKey, context),
              preferenceDerivedFace: true,
            });
            context.navigate(face, target.options);
          },
          onOpenSessionMenu: (row, position, trigger) =>
            this.openSessionMenu(row, position, trigger),
          onToggleDetails: (key) => {
            this.expandedSessionKey = this.expandedSessionKey === key ? null : key;
            if (this.deepLinkSessionKey !== null) {
              this.deepLinkSessionKey = null;
              void this.refreshSessionList();
            }
          },
        }),
        { id: "sessions-hub-panel" },
      )}
      ${this.renderSessionMenu()}
    `;
  }

  private async runPluginAction(id: string, target: Pick<GatewaySessionRow, "key" | "sessionId">) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    try {
      await runControlUiPluginAction({
        runtime: scope.context.plugins,
        id,
        placement: "session",
        sessionKey: target.key,
        session: this.result?.sessions.find(
          (row) => row.key === target.key && row.sessionId === target.sessionId,
        ),
        signal: this.pluginActionLifetime.signal,
      });
    } catch (error) {
      this.publishRequestError(scope, error);
    }
  }
}

if (!customElements.get("openclaw-sessions-page")) {
  customElements.define("openclaw-sessions-page", SessionsPage);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
