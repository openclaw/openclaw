import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { onSettled } from "solid-js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createSessionDetails } from "../../components/session-details.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import { fetchSessionMenuWork } from "../../components/session-menu-work.ts";
import "../../components/session-menu-solid.tsx";
import { moveSessionFromMenu } from "../../components/session-placement-action.ts";
import {
  formatBatchSessionRemovalError,
  withSessionWorkspaceRecovery,
} from "../../components/session-workspace-recovery.runtime.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccessRequest,
} from "../../lib/session-method-access.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  filterSessionRows,
  type SessionArchivedFilter,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import type { SessionPatch, SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  isPinnableUiSessionRow,
  isSubagentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiSessionRowAgentId,
  scopedSessionArtifactKey,
} from "../../lib/sessions/session-key.ts";
import { requestSessionInvolvement } from "../../lib/sessions/session-requests.ts";
import { searchVisibleSessionTranscripts } from "../../lib/sessions/transcript-search.ts";
import { formatPreservedWorktreesNotice } from "../../lib/sessions/worktree-preservation.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import {
  ensureSessionAgentIdentities,
  sessionAgentId,
  sessionAgentIdentityById,
  sessionPathAgentId,
} from "./agent-scope.ts";
import { createSessionsArchive } from "./archive-actions.ts";
import { rememberSessionCustomGroup, sessionCategoryNames } from "./custom-groups.ts";
import { resolveSessionDeleteOutcome } from "./delete-outcome.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import {
  createSessionsMutationRunner,
  type SessionsPageMutationResult,
} from "./mutation-runner.ts";
import { createSessionsDialog } from "./page-dialog.ts";
import { loadStoredGroupBy, saveStoredGroupBy } from "./page-state.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import { createSessionsRosterReadiness } from "./roster-readiness.ts";
import type { SessionsRouteData } from "./route.ts";
import {
  reconcileSelectedSessions,
  settleSelectedSession,
  updateSelectedSessions,
  type SessionDeleteRow,
} from "./selection.ts";
import {
  handleSessionManagementNavigationAction,
  type SessionsPageMenuProps,
} from "./session-menu.tsx";
import type { SessionsAdvancedFiltersProps } from "./sessions-filters.tsx";
import type { SessionsPageListBinding, SessionsPageState } from "./sessions-page-state.types.ts";

registerSessionOrganizationEnglish();

const SESSION_SEARCH_DEBOUNCE_MS = 200;

export type SessionsPageOwner = ReturnType<typeof createSessionsPage>;

export function createSessionsPage(
  application: ApplicationContext,
  initialRouteData?: SessionsRouteData,
) {
  let routeData = initialRouteData;
  let active = true;
  const menuOwner = {};
  function setRouteData(next?: SessionsRouteData) {
    if (routeData === next) {
      return;
    }
    routeData = next;
    applyRouteData();
    synchronize();
    publish();
  }

  // Query and mutation decisions read these facts synchronously; the projection only observes.
  const observation = observeState<SessionsPageState>({
    sortColumn: "updated",
    sortDir: "desc",
    groupBy: loadStoredGroupBy(),
    page: 0,
    pageSize: 25,
    result: null,
    roster: null,
    loading: false,
    refreshing: false,
    error: null,
    activeMinutes: "",
    limit: String(SESSIONS_PAGE_DEFAULT_LIMIT),
    includeGlobal: true,
    includeUnknown: false,
    statusFilter: "active",
    searchQuery: "",
    transcriptSearchQuery: "",
    selectedSessions: new Map<string, SessionDeleteRow>(),
    sessionMenu: null,
    sessionMenuWork: null,
    expandedSessionKey: null,
    transcriptSearch: null,
  });
  const state = observation.state;
  const publish = observation.invalidate;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  let deepLinkSessionKey: string | null = null;

  // Async completions belong to one context/capability/connection/scope epoch. Bump
  // before releasing locks so stale finally blocks cannot clear newer work.
  let pageEpoch = 0;
  let pluginActionLifetime = new AbortController();
  let commandRetirement = Promise.withResolvers<void>();
  let sessionMenuTrigger: HTMLElement | null = null;
  let listBinding: SessionsPageListBinding | undefined;
  let unsubscribeList: (() => void) | undefined;
  let listRequest: Promise<void> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let appliedListResult: SessionsListResult | null | undefined;
  const rosterReadiness = createSessionsRosterReadiness(state);
  const details = createSessionDetails({
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    row: () => state.result?.sessions.find((row) => row.key === state.expandedSessionKey),
    agentId: (row, scope) => row.agentId ?? sessionPathAgentId(row.key, scope.context),
  });
  const inputDialog = createSessionsDialog((message) => {
    state.error = message;
  });
  const sessionMutations = createSessionsMutationRunner({
    isCurrent: isRequestScopeCurrent,
    started: () => {
      state.error = null;
    },
    settled: (outcome) => {
      const binding = listBinding;
      if (binding) {
        applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
      }
      if (outcome && typeof outcome === "object") {
        state.error = outcome.error;
      }
    },
  });
  const observeAgentScope = watchAgentScope(() => {
    // Keep same-connection list serialization.
    retirePageOperations();
    resetTranscriptSearchState(state.transcriptSearchQuery);
    if (!deepLinkSessionKey) {
      state.page = 0;
      state.selectedSessions = new Map();
      clearSearchTimer();
      bindSessionList();
    }
    synchronize();
    publish();
  });

  const gatewayLifecycle = new GatewayPageBinding(
    () => {
      if (active) {
        synchronize();
        publish();
      }
    },
    {
      getGateway: () => application.gateway,
      onIdentityChange: () => {
        const retiredResult = listBinding?.sessions.listSnapshot(listBinding.query).result;
        resetProviderState();
        appliedListResult = retiredResult;
      },
      invalidateRequests: () => {
        if (active) {
          invalidatePageWork();
        }
      },
    },
  );

  let transcriptSearchAbort: AbortController | undefined;
  async function searchTranscripts(query: string) {
    transcriptSearchAbort?.abort();
    const lifetime = new AbortController();
    transcriptSearchAbort = lifetime;
    const scope = captureRequestScope();
    if (!scope) {
      state.transcriptSearch = null;
      return;
    }
    const isCurrent = () => !lifetime.signal.aborted && isRequestScopeCurrent(scope);
    const result = searchVisibleSessionTranscripts({
      client: scope.client,
      query,
      listOptions: sessionListOptions(scope.context, ""),
      isCurrent,
    }).then(
      (searchResult) => (isCurrent() ? searchResult : null),
      (error: unknown) => {
        if (isCurrent()) {
          throw error;
        }
        return null;
      },
    );
    state.transcriptSearch = result;
    // Rendering owns errors; command callers still await the admitted request.
    await result.catch(() => undefined);
  }

  function synchronize() {
    bindSessionList();
    details.synchronize();
  }

  function retirePageOperations() {
    details.reset();
    pluginActionLifetime.abort();
    pluginActionLifetime = new AbortController();
    pageEpoch += 1;
    sessionMutations.retire();
    commandRetirement.resolve();
    commandRetirement = Promise.withResolvers<void>();
    closeSessionMenu();
  }

  function invalidatePageWork() {
    retirePageOperations();
    clearSearchTimer();
    listRequest = undefined;
    rosterReadiness.retire();
    resetTranscriptSearchState(state.transcriptSearchQuery);
    state.loading = false;
    state.refreshing = false;
  }

  function resetProviderState() {
    state.result = null;
    state.error = null;
    state.loading = false;
    state.refreshing = false;
    resetTranscriptSearchState("");
    state.selectedSessions = new Map();
    state.expandedSessionKey = null;
    deepLinkSessionKey = null;
    appliedListResult = undefined;
  }

  const archiveActions = createSessionsArchive({
    captureScope: captureRequestScope,
    clearError: () => {
      state.error = null;
    },
    isCurrent: isRequestScopeCurrent,
    publishError: publishRequestError,
    refresh: refreshSessionList,
    agentId: sessionAgentId,
    patch: patchSession,
  });

  function captureRequestScope(): SessionsPageRequestScope | null {
    if (!active) {
      return null;
    }
    const gateway = application.gateway;
    const client = gatewayLifecycle.gateway === gateway ? gatewayLifecycle.client : null;
    if (!gatewayLifecycle.connected || !client) {
      return null;
    }
    return {
      epoch: pageEpoch,
      signal: pluginActionLifetime.signal,
      context: application,
      gateway,
      sessions: application.sessions,
      client,
    };
  }

  function isRequestScopeCurrent(scope: SessionsPageRequestScope): boolean {
    const gateway = application.gateway;
    return (
      active &&
      pageEpoch === scope.epoch &&
      application === scope.context &&
      gateway === scope.gateway &&
      application.sessions === scope.sessions &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  function publishRequestError(
    scope: SessionsPageRequestScope,
    error: unknown,
  ): SessionsPageMutationResult {
    if (!isRequestScopeCurrent(scope)) {
      return "stale";
    }
    state.error = error;
    return { status: "failed", error };
  }

  function mutationDisabledReason(request: SessionMethodAccessRequest): string | undefined {
    const access = readSessionMethodAccess(application.gateway.snapshot, request);
    return access.allowed ? undefined : access.reason;
  }

  function mutationAccessError(
    scope: SessionsPageRequestScope,
    request: SessionMethodAccessRequest,
  ): string | null {
    const access = readSessionMethodAccess(scope.gateway.snapshot, request);
    if (access.allowed) {
      return null;
    }
    state.error = access.reason;
    return access.reason;
  }

  function selectedDeleteDisabledReason(): string | undefined {
    for (const row of state.selectedSessions.values()) {
      const reason = mutationDisabledReason({
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

  function applyRouteData() {
    const data = routeData;
    if (!data) {
      return;
    }
    state.statusFilter = data.statusFilter;
    state.activeMinutes = "";
    state.limit = String(SESSIONS_PAGE_DEFAULT_LIMIT);
    state.includeGlobal = true;
    state.includeUnknown = Boolean(data.expandedSessionKey);
    if (data.expandedSessionKey) {
      state.searchQuery = "";
      state.page = 0;
      state.selectedSessions = new Map();
    }
    state.expandedSessionKey = data.expandedSessionKey;
    // Only route-driven expansion narrows the list query; interactive drawer
    // opens must keep loading the full roster (see sessionListOptions).
    deepLinkSessionKey = data.expandedSessionKey;
  }

  function sessionListOptions(context: ApplicationContext, search = state.searchQuery) {
    return buildSessionsListQuery(context, {
      activeMinutes: parseStrictPositiveInteger(state.activeMinutes),
      // The Limit box is an explicit page size, so an unparseable entry falls
      // back to the page default rather than to the shared roster page size.
      limit: parseStrictPositiveInteger(state.limit) ?? SESSIONS_PAGE_DEFAULT_LIMIT,
      includeGlobal: state.includeGlobal,
      includeUnknown: state.includeUnknown,
      statusFilter: state.statusFilter,
      deepLinkSessionKey,
      search,
    });
  }

  function bindSessionList(refreshMissing = true): SessionsPageListBinding | undefined {
    if (!active) {
      return undefined;
    }
    const sessions = application.sessions;
    const query = sessionListOptions(application);
    const key = JSON.stringify(query);
    const current = listBinding;
    const transcriptKey = JSON.stringify(sessionListOptions(application, ""));
    if (current?.sessions !== sessions || current.key !== key) {
      // An event refresh can already own the old query's request.
      if (current?.sessions === sessions && sessions.listSnapshot(current.query).loading) {
        void loadSessionList(current);
      }
      unsubscribeList?.();
      unsubscribeList = undefined;
      if (current?.sessions !== sessions || current.transcriptKey !== transcriptKey) {
        resetTranscriptSearchState(state.transcriptSearchQuery);
      }
      // Retired rows cannot be selected under replacement text, even during debounce.
      state.result = null;
      details.synchronize();
      state.error = null;
      state.selectedSessions = new Map();
      state.page = 0;
      listBinding = { sessions, query, key, transcriptKey };
      appliedListResult = undefined;
      rosterReadiness.restart(captureRequestScope() !== null);
    }
    const binding = listBinding!;
    if (unsubscribeList) {
      return binding;
    }
    state.loading = application.gateway.snapshot.phase === "connected";
    if (!captureRequestScope() || searchTimer !== undefined || listRequest) {
      return binding;
    }
    const apply = (snapshot: SessionListSnapshot) => {
      applyListSnapshot(binding, snapshot);
    };
    unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (refreshMissing && (!snapshot.result || snapshot.loading)) {
      void loadSessionList(binding);
    }
    return binding;
  }

  function applyListSnapshot(binding: SessionsPageListBinding, snapshot: SessionListSnapshot) {
    if (listBinding !== binding || application.sessions !== binding.sessions) {
      return;
    }
    rosterReadiness.update(snapshot.loading, snapshot.error);
    const result = snapshot.result;
    if (!result) {
      return;
    }
    if (result !== appliedListResult) {
      appliedListResult = result;
      state.result = filterSessionRows(result, { archivedFilter: state.statusFilter });
      ensureSessionAgentIdentities(application.agentIdentity, state.result);
    }
    if (!snapshot.loading && !snapshot.error && state.result && state.selectedSessions.size > 0) {
      state.selectedSessions = reconcileSelectedSessions(
        state.selectedSessions,
        state.result.sessions,
        (row) =>
          binding.sessions.deletionState(
            row.key,
            sessionAgentId(row.key, application),
            row.sessionId,
          ) === "pending" || binding.sessions.archiveVisibility(row.key) === "pending",
      );
    }
    details.synchronize();
  }

  async function refreshSessionList(scope = captureRequestScope()) {
    if (!scope) {
      return;
    }
    clearSearchTimer();
    const binding = bindSessionList(false);
    if (!binding || binding.sessions !== scope.sessions || !isRequestScopeCurrent(scope)) {
      return;
    }
    state.error = null;
    await loadSessionList(binding, { force: true });
    if (isRequestScopeCurrent(scope) && listBinding === binding) {
      applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
    }
  }

  function loadSessionList(
    binding: SessionsPageListBinding,
    options: { force?: boolean; offset?: number; append?: boolean } = {},
  ): Promise<void> {
    if (listRequest) {
      // Only the bound query may queue mutation invalidation in its managed owner.
      if (options.force && unsubscribeList) {
        void binding.sessions.refreshList({ ...binding.query, ...options });
      }
      return listRequest;
    }
    if (!captureRequestScope()) {
      return Promise.resolve();
    }
    // Claim before refreshList publishes. Only this connection's completion may
    // release the slot; the next query is read from page state, never queued here.
    const completion = createDeferredCore();
    const pending = completion.promise.finally(() => {
      if (listRequest !== pending) {
        return;
      }
      listRequest = undefined;
      state.refreshing = false;
      bindSessionList();
    });
    listRequest = pending;
    state.refreshing = true;
    completion.resolve(binding.sessions.refreshList({ ...binding.query, ...options }));
    return pending;
  }

  function clearSearchTimer() {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }

  function resetTranscriptSearchState(query: string) {
    state.transcriptSearchQuery = query;
    transcriptSearchAbort?.abort();
    state.transcriptSearch = null;
  }

  function updateTranscriptSearchQuery(query: string) {
    if (query === state.transcriptSearchQuery) {
      return;
    }
    // Editing invalidates the visible results and the in-flight query so a
    // late response cannot appear under different search text.
    resetTranscriptSearchState(query);
  }

  async function runTranscriptSearch() {
    const query = state.transcriptSearchQuery.trim();
    if (!query) {
      resetTranscriptSearchState("");
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    state.transcriptSearchQuery = query;
    await searchTranscripts(query);
  }

  function updateFilters(next: Parameters<SessionsAdvancedFiltersProps["onFiltersChange"]>[0]) {
    state.activeMinutes = next.activeMinutes;
    state.limit = next.limit;
    state.includeGlobal = next.includeGlobal;
    state.includeUnknown = next.includeUnknown;
    state.page = 0;
    state.selectedSessions = new Map();
    // Explicit filter edits leave deep-link mode; load the full roster.
    deepLinkSessionKey = null;
    void refreshSessionList();
  }

  function updateStatusFilter(statusFilter: SessionArchivedFilter) {
    if (statusFilter === state.statusFilter) {
      return;
    }
    state.statusFilter = statusFilter;
    clearSearchTimer();
    state.page = 0;
    state.selectedSessions = new Map();
    deepLinkSessionKey = null;
    // Route navigation changes the managed query; mask the old view's rows
    // until its current list subscription publishes.
    state.loading = true;
    state.error = null;
    application.navigate(
      "sessions",
      statusFilter === "active" ? undefined : { search: `?status=${statusFilter}` },
    );
    synchronize();
  }

  function updateSelection(keys: string[], mode: "select" | "toggle" | "deselect") {
    state.selectedSessions = updateSelectedSessions(
      state.selectedSessions,
      state.result?.sessions ?? [],
      keys,
      mode,
    );
  }

  async function deleteSelected() {
    const rows = [...state.selectedSessions.values()];
    if (rows.length === 0 || state.loading || sessionMutations.pending) {
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const message = t(
      rows.length === 1
        ? "sessionsView.deleteSelectedConfirmOne"
        : "sessionsView.deleteSelectedConfirm",
      { count: String(rows.length) },
    );
    if (!(await confirmMutation(message)) || !isRequestScopeCurrent(scope)) {
      return;
    }
    return deleteSessions(rows.filter((row) => state.selectedSessions.get(row.key) === row));
  }

  function confirmMutation(
    message: string,
    options: { confirmLabel?: string; signal?: AbortSignal } = {},
  ) {
    return showConfirmDialog({
      message,
      confirmLabel: t("common.delete"),
      danger: true,
      signal: pluginActionLifetime.signal,
      ...options,
    });
  }

  async function deleteSessions(
    rows: SessionDeleteRow[],
    options: { deleteTranscript?: boolean } = {},
  ) {
    if (rows.length === 0 || state.loading || sessionMutations.pending) {
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const requests = rows.map((row) => ({
      key: row.key,
      agentId: sessionAgentId(row.key, scope.context),
      ...options,
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.archived === true ? { archivedOnly: true } : {}),
    }));
    for (const params of requests) {
      if (mutationAccessError(scope, { method: "sessions.delete", params })) {
        return;
      }
    }
    return sessionMutations.run(scope, async () => {
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
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (!isRequestScopeCurrent(scope) || !result) {
        return undefined;
      }
      if (result.preservedWorktrees.length > 0) {
        window.alert(formatPreservedWorktreesNotice(result.preservedWorktrees));
      }
      if (result.deleted.length > 0) {
        const outcome = resolveSessionDeleteOutcome(scope.context, requests, result.deleted, {
          selectedSessions: state.selectedSessions,
          expandedSessionKey: state.expandedSessionKey,
          deepLinkSessionKey,
        });
        state.selectedSessions = outcome.selectedSessions;
        state.expandedSessionKey = outcome.expandedSessionKey;
        deepLinkSessionKey = outcome.deepLinkSessionKey;
        if (outcome.selection) {
          selectApplicationSession({
            selection: scope.context.agentSelection,
            gateway: scope.gateway,
            ...outcome.selection,
          });
        }
      }
      await refreshSessionList(scope);
      return result.errors.length > 0
        ? {
            status: "failed",
            error: result.errors
              .map(({ error }) => formatBatchSessionRemovalError(error))
              .join("; "),
          }
        : "completed";
    });
  }

  async function deleteAllArchived() {
    const scope = captureRequestScope();
    if (!scope || state.loading || sessionMutations.pending) {
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
      } = sessionListOptions(scope.context);
      const agentId = scope.context.agentSelection.state.scopeId?.trim();
      const listOptions = { ...filters, ...(agentId ? { agentId } : {}) };
      const listed = await fetchPagedSessionRows({
        list: (offset) => scope.sessions.list({ ...listOptions, limit: 1000, offset }),
        isCurrent: () => isRequestScopeCurrent(scope),
        missingResultError: "archived session enumeration returned no result",
        stalledPaginationError: "archived session enumeration did not advance",
        incompletePaginationError: "archived session enumeration was incomplete",
      });
      if (!listed) {
        return;
      }
      rows = listed;
    } catch (error) {
      return publishRequestError(scope, error);
    }
    const archivedRows = rows.filter((row) => row.archived === true);
    if (archivedRows.length === 0) {
      return;
    }
    if (
      !(await confirmMutation(
        t("sessionsView.deleteAllArchivedConfirm", {
          count: String(archivedRows.length),
        }),
        { signal: scope.signal },
      )) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    return deleteSessions(archivedRows, { deleteTranscript: true });
  }

  async function deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const scope = captureRequestScope();
    if (
      !scope ||
      !(await confirmMutation(t("sessionsView.deleteSessionConfirm", { session: label }))) ||
      !isRequestScopeCurrent(scope)
    ) {
      return;
    }
    return deleteSessions([row]);
  }

  async function stopCloudWorker(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const stopAction = resolveCloudWorkerStopAction(row.placement);
    if (!stopAction || (stopAction.blocksActiveRun && row.hasActiveRun === true)) {
      return;
    }
    const scope = captureRequestScope();
    if (
      !scope ||
      !(await confirmMutation(t("sessionsView.stopCloudWorkerConfirm", { session: label }), {
        confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
      })) ||
      !isRequestScopeCurrent(scope) ||
      mutationAccessError(scope, stopAction)
    ) {
      return;
    }
    return sessionMutations.run(scope, async () => {
      const agentId = resolveUiSessionRowAgentId(row, sessionPathAgentId(row.key, scope.context));
      await requestCloudWorkerStop(
        scope.client,
        {
          key: row.key,
          ...(agentId ? { agentId } : {}),
        },
        scope.context.placementStartup,
      );
      if (isRequestScopeCurrent(scope)) {
        await refreshSessionList(scope);
      }
      return "completed";
    });
  }

  function knownCategories(): string[] {
    return sessionCategoryNames(state.result, application.sessions.state.groups ?? []);
  }

  async function rememberCustomGroup(
    name: string,
    scope: SessionsPageRequestScope | null = captureRequestScope(),
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      return "stale";
    }
    const accessError = mutationAccessError(scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    });
    if (accessError) {
      return { status: "failed", error: accessError };
    }
    state.error = null;
    return rememberSessionCustomGroup({
      name,
      knownCategories: knownCategories(),
      sessions: scope.sessions,
      isCurrent: () => isRequestScopeCurrent(scope),
      onError: (message) => {
        state.error = message;
      },
    });
  }

  async function assignCategory(key: string, category: string | null) {
    // Only patch keys that exist in the current result; sessions.patch would
    // otherwise create a store entry for arbitrary dropped text.
    const session = state.result?.sessions.find((row) => row.key === key);
    if (!session) {
      return undefined;
    }
    // Dropping a row onto its own section is a no-op; skip the patch round-trip.
    const current = session.category?.trim() || null;
    const promote = !isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session);
    if (current === category && !promote) {
      return undefined;
    }
    const scope = captureRequestScope();
    if (!scope) {
      return undefined;
    }
    if (category) {
      const remembered = await rememberCustomGroup(category, scope);
      if (remembered !== "completed") {
        return remembered;
      }
    }
    return patchSession(
      key,
      { category, ...(promote ? { sidebarRoot: true } : {}) },
      scope,
      session.sessionId,
    );
  }

  async function requestNewCategory(sessionKey?: string) {
    // Capture before loading the dialog: its key may belong to a replacement
    // by the time the operator submits or the catalog write completes.
    const session = state.result?.sessions.find((row) => row.key === sessionKey);
    if (sessionKey && !session?.sessionId) {
      state.error = t("common.refresh");
      return;
    }
    await inputDialog.open(() => ({
      title: t("sessionsView.newGroupTitle"),
      label: t("sessionsView.newGroupPrompt"),
      submitLabel: t("sessionsView.newGroupCreate"),
      requireValue: true,
      submit: (name) => writeNewCategory(name, session),
    }));
  }

  /**
   * One captured scope covers both writes: the catalog entry lands before the
   * row moves, and a catalog write that outlived its connection must not be
   * followed by an assignment issued on the replacement one.
   */
  async function writeNewCategory(
    name: string,
    session?: GatewaySessionRow,
  ): Promise<string | null> {
    state.error = null;
    const scope = captureRequestScope();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const remembered = await rememberCustomGroup(name, scope);
    if (remembered !== "completed") {
      return typeof remembered === "object"
        ? formatUiError(remembered.error)
        : t("sessionsView.newGroupStale");
    }
    if (!session) {
      return null;
    }
    const assigned = await patchSession(
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
    if (typeof assigned === "object") {
      return formatUiError(assigned.error);
    }
    return assigned === "stale" ? t("sessionsView.newGroupStale") : null;
  }

  async function renameSession(row: GatewaySessionRow) {
    await inputDialog.rename(row, captureRequestScope(), isRequestScopeCurrent, (scope, patch) =>
      patchSession(row.key, patch, scope, row.sessionId, { sessionScope: true }),
    );
  }

  async function patchSession(
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope | null = captureRequestScope(),
    expectedSessionId?: string,
    options: { onConfirmed?: (result: SessionPatchResult) => void; sessionScope?: boolean } = {},
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      // Nothing was attempted (e.g. rename dialog submitted after the gateway
      // dropped); say so instead of silently swallowing the edit.
      state.error = t("sessionsView.actionRequiresConnection");
      return { status: "failed", error: t("sessionsView.actionRequiresConnection") };
    }
    if (typeof patch.archived === "boolean" && !expectedSessionId?.trim()) {
      state.error = "Session lifecycle action requires a durable session identity.";
      return {
        status: "failed",
        error: "Session lifecycle action requires a durable session identity.",
      };
    }
    const agentId = sessionAgentId(key, scope.context);
    const row = state.result?.sessions.find((entry) => entry.key === key);
    const accessError = mutationAccessError(scope, {
      method: "sessions.patch",
      sessionScope: options.sessionScope,
      session: row,
      params: {
        key,
        ...patch,
        ...(agentId ? { agentId } : {}),
      },
    });
    if (accessError) {
      return { status: "failed", error: accessError };
    }
    state.error = null;
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
              isCurrent: () => isRequestScopeCurrent(scope),
              request,
            })
          : await request();
      if (patched && !("queued" in patched)) {
        options.onConfirmed?.(patched);
      }
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        return "stale";
      }
      if ("queued" in patched) {
        return "completed";
      }
      await refreshSessionList(scope);
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      const selected = state.selectedSessions;
      state.selectedSessions = settleSelectedSession(selected, key, patched.entry.sessionId);
      return "completed";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }

  async function forkSession(
    key: string,
    fromLastCompleted = false,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = sessionAgentId(key, scope.context);
    const createParams = {
      parentSessionKey: key,
      fork: true,
      ...(fromLastCompleted ? { forkFrom: "last-completed" as const } : {}),
      ...(agentId ? { agentId } : {}),
    };
    if (mutationAccessError(scope, { method: "sessions.create", params: createParams })) {
      return;
    }
    state.error = null;
    try {
      const forked = await scope.sessions.createResult(createParams, { signal: scope.signal });
      if (!isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (forked) {
        const forkedKey = forked.key;
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: forkedKey,
            agentId: agentId ?? sessionPathAgentId(forkedKey, scope.context),
          }).options,
          hash: "",
        });
      }
      return forked ? "completed" : "stale";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }

  function openSessionMenu(
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (
      state.sessionMenu?.key === row.key &&
      state.sessionMenu.sessionId === row.sessionId &&
      trigger
    ) {
      closeSessionMenu();
      return;
    }
    state.sessionMenu = { key: row.key, sessionId: row.sessionId, ...position };
    sessionMenuTrigger = trigger;
    loadSessionMenuWork(row);
  }

  function closeSessionMenu() {
    sessionPullRequestsForGateway(application.gateway).unwatch(menuOwner);
    state.sessionMenu = null;
    sessionMenuTrigger = null;
    state.sessionMenuWork = null;
  }

  function loadSessionMenuWork(row: GatewaySessionRow) {
    if (!row.worktree) {
      state.sessionMenuWork = null;
      return;
    }
    const scope = captureRequestScope();
    if (!scope) {
      state.sessionMenuWork = null;
      return;
    }
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionArtifactKey(
      row.key,
      sessionAgentId(row.key, scope.context),
    );
    state.sessionMenuWork = fetchSessionMenuWork({
      client: scope.client,
      loadPullRequests: canCallGatewayMethod(
        scope.context.gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
        ? () => store.load(menuOwner, pullRequestKey)
        : undefined,
      worktreeId: row.worktree.id,
      execNode: row.execNode,
    }).then((work) => (isRequestScopeCurrent(scope) ? work : null));
  }

  function sessionMenuProps(): SessionsPageMenuProps | null {
    const menu = state.sessionMenu;
    const row = menu
      ? state.result?.sessions.find(
          (session) => session.key === menu.key && session.sessionId === menu.sessionId,
        )
      : null;
    if (!menu || !row) {
      return null;
    }
    return {
      context: application,
      row,
      menu,
      trigger: sessionMenuTrigger,
      disabled: state.loading,
      groups: knownCategories(),
      work: state.sessionMenuWork,
      onClose: () => closeSessionMenu(),
      onAction: (
        requestedAction,
        onAdmittedCommand,
      ): Promise<SessionsPageMutationResult | void> | void => {
        const action = handleSessionManagementNavigationAction(requestedAction, {
          context: application,
          row,
          isCurrent: () => active,
        });
        if (!action) {
          return undefined;
        }
        switch (action.kind) {
          case "toggle-pin":
            togglePinnedSession(application.navigation, row.key);
            break;
          case "toggle-involving-me": {
            const scope = captureRequestScope();
            if (!scope || !row.sessionId) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            return requestSessionInvolvement(scope.client, {
              key: row.key,
              expectedSessionId: row.sessionId,
              agentId: row.agentId ?? sessionAgentId(row.key, scope.context),
              hidden: !row.hiddenFromInvolvingMe,
            })
              .then(async () => {
                if (isRequestScopeCurrent(scope)) {
                  await refreshSessionList(scope);
                }
              })
              .catch((error: unknown) => publishRequestError(scope, error));
          }
          case "toggle-unread":
            return actions.patchSession(
              row.key,
              { unread: row.unread !== true },
              undefined,
              row.sessionId,
              {
                sessionScope: true,
              },
            );
          case "rename":
            void renameSession(row);
            break;
          case "set-color":
            return actions.patchSession(row.key, { color: action.color });
          case "set-icon":
            return actions.patchSession(row.key, { icon: action.icon });
          case "set-communication":
            return actions.patchSession(
              row.key,
              { communication: action.communication },
              undefined,
              row.sessionId,
            );
          case "reset-appearance":
            return actions.patchSession(row.key, { icon: null, color: null });
          case "move-session": {
            const scope = captureRequestScope();
            if (!scope) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            return moveSessionFromMenu({
              context: scope.context,
              row,
              fallbackAgentId: sessionPathAgentId(row.key, scope.context),
              isCurrent: () => isRequestScopeCurrent(scope),
              onAdmittedCommand,
              currentRow: () =>
                state.result?.sessions.find(
                  (candidate) => candidate.key === row.key && candidate.sessionId === row.sessionId,
                ),
              publishError: (error) => {
                publishRequestError(scope, error);
              },
            }).catch((error: unknown) => publishRequestError(scope, error));
          }
          case "fork":
            return actions.forkSession(row.key, row.hasActiveRun === true);
          case "plugin":
            return actions.runPluginAction(action.id, menu);
          case "move-to-top-level":
            return actions.patchSession(row.key, { sidebarRoot: true }, undefined, row.sessionId, {
              sessionScope: true,
            });
          case "move-to-group":
            return assignCategory(row.key, action.category);
          case "new-group":
            void actions.requestNewCategory(row.key);
            break;
          case "toggle-archived": {
            if (row.archived === true) {
              return actions.patchSession(row.key, { archived: false }, undefined, row.sessionId, {
                sessionScope: true,
              });
            }
            const rows = state.result?.sessions ?? [];
            return actions.archive(row, hasSessionArchiveDescendants(row, rows));
          }
          case "assign-owner": {
            const scope = captureRequestScope();
            if (!scope) {
              state.error = t("sessionsView.actionRequiresConnection");
              break;
            }
            if (
              mutationAccessError(scope, {
                method: "sessions.assignOwner",
                params: { key: row.key, owner: action.owner },
                requiredScope: "operator.write",
              })
            ) {
              break;
            }
            return sessionMutations.run(scope, async () => {
              const assigned = await scope.sessions.assignOwner(row.key, action.owner);
              return assigned ? "completed" : "stale";
            });
          }
          case "stop-cloud-worker":
            return actions.stopCloudWorker(row);
          case "delete":
            return actions.deleteSessionFromMenu(row);
        }
        return undefined;
      },
    };
  }

  function viewProps() {
    const { selectedSessions, sessionMenuWork: _sessionMenuWork, ...viewState } = state;
    const personGroupingAvailable = (state.result?.owners?.length ?? 0) > 1;
    return {
      ...viewState,
      commandEpoch: pageEpoch,
      // The descriptor read belongs to the expanded slot, outside this aggregate snapshot.
      detailsRead: details.read,
      detailsReadKey: details.readKey,
      onRetryDetails: details.retry,
      refreshDisabled: application.gateway.snapshot.phase !== "connected",
      basePath: application.basePath,
      agentId: resolveSessionNavigationAgentId(application),
      allAgentsScope: application.agentSelection.state.scopeId === null,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: application.agents.state.agentsList,
        hello: application.gateway.snapshot.hello,
      }),
      transcriptSearchAvailable: application.gateway.snapshot.phase === "connected",
      agentIdentityById: sessionAgentIdentityById(
        state.result,
        (agentId) => application.agentIdentity.get(agentId) ?? undefined,
      ),
      personGroupingAvailable,
      // Keep the stored Person preference while the owner roster is unavailable.
      groupBy:
        personGroupingAvailable || state.groupBy !== "person" ? state.groupBy : ("none" as const),
      knownCategories: knownCategories(),
      selectedKeys: new Set(selectedSessions.keys()),
      labelDisabledReason: (row: GatewaySessionRow) =>
        mutationDisabledReason({
          method: "sessions.patch",
          params: { key: row.key, label: null },
          sessionScope: true,
          session: row,
        }),
      patchAdminDisabledReason: mutationDisabledReason({
        method: "sessions.patch",
        params: { key: "", thinkingLevel: null },
      }),
      groupWriteDisabledReason: mutationDisabledReason({
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
      deleteArchivedDisabledReason: mutationDisabledReason({
        method: "sessions.delete",
        params: { key: "", archivedOnly: true, deleteTranscript: true },
      }),
      deleteSelectedDisabledReason: selectedDeleteDisabledReason(),
      onFiltersChange: (next: Parameters<typeof updateFilters>[0]) => updateFilters(next),
      onClearFilters: () => {
        state.searchQuery = "";
        updateFilters({
          activeMinutes: "",
          limit: String(SESSIONS_PAGE_DEFAULT_LIMIT),
          includeGlobal: true,
          includeUnknown: false,
        });
      },
      onSearchChange: (query: string) => {
        deepLinkSessionKey = null;
        state.searchQuery = query;
        state.page = 0;
        state.selectedSessions = new Map();
        clearSearchTimer();
        if (captureRequestScope()) {
          searchTimer = setTimeout(() => {
            searchTimer = undefined;
            bindSessionList();
          }, SESSION_SEARCH_DEBOUNCE_MS);
        }
        bindSessionList();
      },
      onTranscriptSearchChange: actions.updateTranscriptSearchQuery,
      onTranscriptSearch: (): void => void actions.runTranscriptSearch(),
      onClearTranscriptSearch: () => resetTranscriptSearchState(""),
      onSortChange: (
        column: SessionsPageState["sortColumn"],
        direction: SessionsPageState["sortDir"],
      ) => {
        state.sortColumn = column;
        state.sortDir = direction;
        state.page = 0;
      },
      onGroupByChange: (mode: SessionsPageState["groupBy"]) => {
        state.groupBy = mode;
        state.page = 0;
        saveStoredGroupBy(mode);
      },
      onAssignCategory: assignCategory,
      onRequestNewCategory: (sessionKey?: string): void =>
        void actions.requestNewCategory(sessionKey),
      onLoadMore: () => {
        const binding = listBinding;
        const offset = state.result?.nextOffset;
        if (binding && state.result?.hasMore && offset != null && !state.loading) {
          void loadSessionList(binding, { offset, append: true });
        }
      },
      onPageChange: (page: number) => {
        state.page = page;
      },
      onPageSizeChange: (pageSize: number) => {
        state.pageSize = pageSize;
        state.page = 0;
      },
      onRefresh: (): void => void refreshSessionList(),
      onStatusFilterChange: (statusFilter: SessionArchivedFilter) =>
        updateStatusFilter(statusFilter),
      onDeleteAllArchived: () => actions.deleteAllArchived(),
      onPatch: (key: string, patch: SessionPatch, options?: { sessionScope?: boolean }) =>
        actions.patchSession(key, patch, undefined, undefined, options),
      onToggleSelect: (key: string) => updateSelection([key], "toggle"),
      onSelectPage: (keys: string[]) => updateSelection(keys, "select"),
      onDeselectPage: (keys: string[]) => updateSelection(keys, "deselect"),
      onDeselectAll: () => {
        state.selectedSessions = new Map();
      },
      onDeleteSelected: () => actions.deleteSelected(),
      onNavigateToChat: (sessionKey: string) => {
        const face = resolveSessionPreferredFaceForKey(application, sessionKey);
        const target = sessionNavigationTarget({
          context: application,
          face,
          sessionKey,
          agentId: sessionPathAgentId(sessionKey, application),
          preferenceDerivedFace: true,
        });
        application.navigate(face, target.options);
      },
      onOpenSessionMenu: actions.openSessionMenu,
      onToggleDetails: (key: string) => {
        state.expandedSessionKey = state.expandedSessionKey === key ? null : key;
        details.synchronize();
        if (deepLinkSessionKey !== null) {
          deepLinkSessionKey = null;
          void refreshSessionList();
        }
      },
    };
  }

  async function runPluginAction(
    id: string,
    target: Pick<GatewaySessionRow, "key" | "sessionId">,
  ): Promise<SessionsPageMutationResult | void> {
    const scope = captureRequestScope();
    if (!scope) {
      return;
    }
    state.error = null;
    try {
      await runControlUiPluginAction({
        runtime: scope.context.plugins,
        id,
        placement: "session",
        sessionKey: target.key,
        session: state.result?.sessions.find(
          (row) => row.key === target.key && row.sessionId === target.sessionId,
        ),
        signal: pluginActionLifetime.signal,
        isCurrent: () => isRequestScopeCurrent(scope),
      });
      return isRequestScopeCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      return publishRequestError(scope, error);
    }
  }
  const actions = {
    deleteSelected,
    deleteAllArchived,
    deleteSessionFromMenu,
    stopCloudWorker,
    rememberCustomGroup,
    requestNewCategory,
    patchSession,
    forkSession,
    runPluginAction,
    updateTranscriptSearchQuery,
    runTranscriptSearch,
    openSessionMenu,
    archive: archiveActions.archive,
  };

  const presentationSources = [
    application.agentIdentity,
    application.navigation,
    application.runtimeConfig,
    application.plugins,
  ].map((owner) => projectOwner(owner, (source) => source));
  const revision = () =>
    presentationSources.reduce((sum, source) => sum + source.revision(), observation.revision());
  onSettled(() => {
    const stopScope = observeAgentScope(application.agentSelection);
    applyRouteData();
    gatewayLifecycle.connect();
    return () => {
      active = false;
      rosterReadiness.dispose();
      commandRetirement.resolve();
      observation.dispose();
      stopScope();
      unsubscribeList?.();
      pluginActionLifetime.abort();
      transcriptSearchAbort?.abort();
      clearSearchTimer();
      inputDialog.abort();
      sessionPullRequestsForGateway(application.gateway).unwatch(menuOwner);
      gatewayLifecycle.dispose();
    };
  });
  return {
    actions,
    // Retire presentation waits without changing an issued mutation's settlement.
    observeCommandCompletion: <T>(completion: Promise<T>): Promise<T | void> =>
      Promise.race([completion, commandRetirement.promise]),
    setRouteData,
    revision,
    menu: () => {
      revision();
      return sessionMenuProps();
    },
    view: () => {
      revision();
      return viewProps();
    },
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
