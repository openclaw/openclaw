import { onSettled } from "solid-js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createSessionDetails } from "../../components/session-details.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  filterSessionRows,
  type SessionArchivedFilter,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import {
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import {
  sessionAgentId,
  sessionAgentIds,
  sessionAgentIdentityById,
  sessionPathAgentId,
} from "./agent-scope.ts";
import { createSessionsArchive } from "./archive-actions.ts";
import { createSessionGroups } from "./custom-groups.ts";
import { resolveSessionDeleteOutcome } from "./delete-outcome.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import { createSessionsDialog } from "./page-dialog.ts";
import { loadStoredGroupBy, saveStoredGroupBy } from "./page-state.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import { createSessionsRosterReadiness } from "./roster-readiness.ts";
import type { SessionsRouteData } from "./route.ts";
import {
  reconcileSelectedSessions,
  updateSelectedSessions,
  type SessionDeleteRow,
} from "./selection.ts";
import type { SessionsAdvancedFiltersProps } from "./sessions-filters.tsx";
import { createSessionsPageMenu } from "./sessions-page-menu.ts";
import { createSessionsPageMutations } from "./sessions-page-mutations.ts";
import type { SessionsPageListBinding, SessionsPageState } from "./sessions-page-state.types.ts";
import { createTranscriptSearch } from "./transcript-search.ts";

registerSessionOrganizationEnglish();

const SESSION_SEARCH_DEBOUNCE_MS = 200;

export type SessionsPageOwner = ReturnType<typeof createSessionsPage>;

export function createSessionsPage(
  application: ApplicationContext,
  initialRouteData?: SessionsRouteData,
) {
  let routeData = initialRouteData;
  let active = true;
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
  const transcriptSearch = createTranscriptSearch({
    state,
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    listOptions: (scope) => sessionListOptions(scope.context, ""),
  });
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  let deepLinkSessionKey: string | null = null;

  // Async completions belong to one context/capability/connection/scope epoch. Bump
  // before releasing locks so stale finally blocks cannot clear newer work.
  let pageEpoch = 0;
  let pluginActionLifetime = new AbortController();
  let commandRetirement = Promise.withResolvers<void>();
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
  const mutations = createSessionsPageMutations({
    application,
    state,
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    refresh: refreshSessionList,
    listOptions: sessionListOptions,
    reconcile: () => {
      const binding = listBinding;
      if (binding) {
        applyListSnapshot(binding, binding.sessions.listSnapshot(binding.query));
      }
    },
    onDeleted: (scope, requests, deleted) => {
      const outcome = resolveSessionDeleteOutcome(scope.context, requests, deleted, {
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
    },
  });
  const {
    patchSession,
    publishError: publishRequestError,
    accessError: mutationAccessError,
    disabledReason: mutationDisabledReason,
    selectedDeleteDisabledReason,
  } = mutations;
  const observeAgentScope = watchAgentScope(() => {
    // Keep same-connection list serialization.
    retirePageOperations();
    transcriptSearch.reset();
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

  function synchronize() {
    bindSessionList();
    details.synchronize();
  }

  function retirePageOperations() {
    details.reset();
    pluginActionLifetime.abort();
    pluginActionLifetime = new AbortController();
    pageEpoch += 1;
    mutations.retire();
    commandRetirement.resolve();
    commandRetirement = Promise.withResolvers<void>();
    menu.close();
  }

  function invalidatePageWork() {
    retirePageOperations();
    clearSearchTimer();
    listRequest = undefined;
    rosterReadiness.retire();
    transcriptSearch.reset();
    state.loading = false;
    state.refreshing = false;
  }

  function resetProviderState() {
    state.result = null;
    state.error = null;
    state.loading = false;
    state.refreshing = false;
    transcriptSearch.reset("");
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

  const groups = createSessionGroups({
    state,
    customGroups: () => application.sessions.state.groups ?? [],
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    accessError: (scope) =>
      mutationAccessError(scope, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
    patch: patchSession,
    dialog: inputDialog,
  });

  const menu = createSessionsPageMenu({
    context: application,
    state,
    captureScope: captureRequestScope,
    isCurrent: isRequestScopeCurrent,
    isActive: () => active,
    groups,
    mutations,
    archive: archiveActions.archive,
    rename: renameSession,
    refresh: refreshSessionList,
    publishError: publishRequestError,
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
    return buildSessionsListQuery(
      context.agentSelection.state.scopeId,
      state,
      deepLinkSessionKey,
      search,
    );
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
        transcriptSearch.reset();
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
      void application.agentIdentity.ensure(sessionAgentIds(state.result));
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

  async function renameSession(row: GatewaySessionRow) {
    await inputDialog.rename(row, captureRequestScope(), isRequestScopeCurrent, (scope, patch) =>
      patchSession(row.key, patch, scope, row.sessionId, { sessionScope: true }),
    );
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
      knownCategories: groups.known(),
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
      onClearTranscriptSearch: () => transcriptSearch.reset(""),
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
      onAssignCategory: groups.assign,
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

  const actions = {
    deleteSelected: mutations.deleteSelected,
    deleteAllArchived: mutations.deleteAllArchived,
    deleteSessionFromMenu: mutations.deleteSessionFromMenu,
    stopCloudWorker: mutations.stopCloudWorker,
    rememberCustomGroup: groups.remember,
    requestNewCategory: groups.create,
    patchSession,
    forkSession: mutations.forkSession,
    runPluginAction: mutations.runPluginAction,
    updateTranscriptSearchQuery: transcriptSearch.update,
    runTranscriptSearch: transcriptSearch.run,
    openSessionMenu: menu.open,
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
      clearSearchTimer();
      inputDialog.abort();
      menu.dispose();
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
      return menu.props();
    },
    view: () => {
      revision();
      return viewProps();
    },
  };
}
