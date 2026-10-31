import { createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import { togglePinnedAgent } from "../../app/bootstrap-navigation-preferences.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { buildToolsEffectiveRequestKey, type AgentsState } from "../../lib/agents/index.ts";
import { setDefaultAgent } from "../../lib/agents/mutations.ts";
import { DEFAULT_AGENT_PANEL, type AgentsPanel } from "../../lib/agents/panels.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import {
  hasCronInventoryEvents,
  isCronInventoryInvalidation,
} from "../../lib/cron/inventory-connection.ts";
import type { CronState } from "../../lib/cron/types.ts";
import {
  canCallGatewayMethod,
  canPresentGatewayMethod,
  type GatewayMethodOperatorScope,
} from "../../lib/gateway-methods.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createGitHubIdentityView } from "../../lib/reactive/domain-github-identity.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { createAgentConfigActions } from "./agent-config-actions.ts";
import { createAgentCronPresenter } from "./agent-cron-presenter.ts";
import { createAgentIdentityEditor } from "./agent-identity-editor.ts";
import { createAgentModelCatalog } from "./agent-model-catalog.ts";
import { createAgentsPageLifetime } from "./agents-page-lifetime.ts";
import { createAgentFilePanel, type AgentFilesState, type AgentFilesViewState } from "./files.ts";
import {
  type AgentIdentityDraft,
  type AgentIdentityOutcome,
  resetIdentityDraft,
} from "./identity-actions.ts";
import type { AgentMemoryTarget } from "./memory/memory-panel-state.ts";
import {
  navigateToAgent,
  navigateToAgentPanel,
  syncAgentsCanonicalLocation,
} from "./route-navigation.ts";
import type { AgentsRouteData } from "./route.ts";
import { createAgentSelectionDrafts } from "./selection-drafts.ts";
import {
  createAgentSkillsReset,
  createAgentSkillsReader,
  type AgentSkillsState,
} from "./skills.ts";
import { createAgentToolsCatalog, createAgentEffectiveTools } from "./tools.ts";

type AgentsPageData = Omit<AgentsState, "agentsLoading" | "agentsError" | "agentsList"> &
  AgentFilesState &
  AgentFilesViewState &
  AgentSkillsState & {
    readonly agentsList: AgentsState["agentsList"];
    chatModelCatalogRead: Promise<void> | null;
    identityDraft: AgentIdentityDraft;
    identitySaving: boolean;
    identityOutcome: Promise<AgentIdentityOutcome> | null;
    cron: CronState;
    sessionKey: string;
    agentsPanel: AgentsPanel;
  };
type AgentsViewData = Omit<
  AgentsPageData,
  | "client"
  | "connected"
  | "agents"
  | "sessions"
  | "sessionsResult"
  | "sessionKey"
  | "agentFileWriteRevisions"
>;

export type AgentsPageView = ReturnType<ReturnType<typeof createAgentsPageState>["read"]>;

export function createAgentsPageState(
  context: ApplicationContext,
  initialRouteData?: AgentsRouteData,
) {
  let routeData = initialRouteData;
  let active = true;
  const presentation = createAgentsPageLifetime();
  const [skillsFilter, setSkillsFilter] = createSignal("");
  const identities = projectOwner(context.agentIdentity, (identity) => identity.entries());
  const channelCapability = context.acquireChannels(createChannelCapability);
  const channels = projectOwner(channelCapability, (source) => source.state);
  const navigation = projectOwner(context.navigation, (source) => source.snapshot);
  // The domain helpers mutate then read their state synchronously; Solid only observes it.
  const observation = observeState<AgentsPageData>({
    get agentsList() {
      return context.agents.state.agentsList;
    },
    agentsSelectedId: null,
    chatModelCatalogRead: null,
    agentFilesLoading: false,
    agentFileRead: null,
    agentFileOutcome: null,
    agentFilesList: null,
    agentFileEditors: {},
    agentFileConflict: null,
    agentFileActive: null,
    agentFileSaving: false,
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityOutcome: null,
    agentSkillsRead: null,
    agentSkillsReport: null,
    agentSkillsAgentId: null,
    cron: createInitialCronState(),
    agentFileWriteRevisions: new Map(),
    get agents() {
      return context.agents;
    },
    get sessions() {
      return context.sessions;
    },
    get sessionsResult() {
      return context.sessions.state.result;
    },
    get client() {
      return gateway.client;
    },
    get connected() {
      return gateway.connected;
    },
    get requestGeneration() {
      return gateway.epoch;
    },
    get sessionKey() {
      return context.gateway.snapshot.sessionKey;
    },
    get agentsPanel() {
      return routeData?.panel ?? DEFAULT_AGENT_PANEL;
    },
  });
  const state = observation.state;
  const readData: () => AgentsViewData = observation.read;
  const readChannels: () => Pick<
    ReturnType<typeof channels.read>,
    "channelsSnapshot" | "channelsRead" | "channelsError" | "channelsLastSuccess"
  > = channels.read;
  const publish = observation.invalidate;
  const cron = createAgentCronPresenter({
    currentState: () => state.cron,
    readState: () => readData().cron,
    canCall: (method, scope) =>
      active &&
      state.agentsPanel === "cron" &&
      document.visibilityState !== "hidden" &&
      canCall(method, scope),
    publish,
  });
  const selectionDrafts = createAgentSelectionDrafts(state, resetSelectionState);
  let identitySaves = selectionDrafts.bindContext(context);
  const identity = createAgentIdentityEditor(context, state, {
    snapshot: () => gateway.snapshot,
    saves: () => identitySaves,
    retired: presentation.retired,
    canCall: (method) => canCall(method, "operator.admin"),
    isCurrent: isCurrentRequest,
    onSaved: syncAgentState,
  });
  const skills = createAgentSkillsReader(state);
  const files = createAgentFilePanel(state, {
    canWrite: () => canCall("agents.files.set", "operator.admin"),
    isCurrent: (client, generation, agentId) => isCurrentRequest(client, generation, agentId, {}),
  });
  const skillReset = createAgentSkillsReset({
    retired: presentation.retired,
    state,
    context,
    canReset: () => canCall("config.patch", "operator.admin"),
    isCurrent: (client, generation, agentId, agents) =>
      isCurrentRequest(client, generation, agentId, { agents }),
    onUpdated: (agentId) => skills.refresh(agentId),
  });
  const modelCatalog = createAgentModelCatalog(context, state, publish);
  let routeDataInitialized = false;
  let applyingRouteSelection = false;
  let routeSelectionSuperseded = false;
  let normalizedLocation = "";
  const configActions = createAgentConfigActions({
    getRuntimeConfig: () => context.runtimeConfig,
    canUpdate: (agentId: string) =>
      agentId === state.agentsSelectedId && canCall("config.set", "operator.admin"),
    getReport: () => state.agentSkillsReport,
    onPrimaryChanged: () => effectiveTools.ensure(true),
  });
  const githubIdentity = createGitHubIdentityView({
    runExternalMutation: (task, options) =>
      context.runtimeConfig.runExternalMutation(task, options),
  });
  const gateway = new GatewayPageBinding(() => publish(), {
    getGateway: () => context.gateway,
    // A new source or client owns a new set of drafts. A same-client reconnect
    // only invalidates in-flight requests below and keeps its drafts visible.
    onIdentityChange: () => resetForSourceChange(),
    invalidateRequests: (change) => {
      if (change.identityChanged) {
        return;
      }
      invalidateTransientRequests();
      modelCatalog.reset();
    },
    onSnapshot: ({ snapshot: gatewaySnapshot, becameAvailable, becameConnected }) => {
      identitySaves = selectionDrafts.bindContext(context);
      selectionDrafts.observeGateway(gatewaySnapshot);
      syncGatewayState();
      if (gatewaySnapshot.phase === "connected" && !canCall("tools.catalog", "operator.read")) {
        toolsCatalog.reset();
      }
      if (gatewaySnapshot.phase === "connected" && !canCall("tools.effective", "operator.read")) {
        effectiveTools.reset();
      }
      if (becameConnected && Object.values(state.identityDraft).some((value) => value !== null)) {
        identity.schedule();
      }
      syncGitHubIdentity(state.agentsSelectedId);
      if (becameAvailable && !becameConnected) {
        modelCatalog.onAvailable();
      }
    },
    ensureInitialData: () => ensureInitialData(),
    onPageActivation: () => effectiveTools.ensure(),
  });
  const isCurrentToolsRead = (client: GatewayBrowserClient, generation: number, agentId: string) =>
    isCurrentRequest(client, generation, agentId, {});
  const toolsCatalog = createAgentToolsCatalog({
    scope: () => state,
    canRead: () =>
      canPresentGatewayMethod(context.gateway.snapshot, "tools.catalog", "operator.read"),
    isCurrent: isCurrentToolsRead,
  });
  const effectiveTools = createAgentEffectiveTools({
    scope: () => state,
    canRead: () =>
      canPresentGatewayMethod(context.gateway.snapshot, "tools.effective", "operator.read"),
    isCurrent: isCurrentToolsRead,
    isSessionAgent: (agentId) => agentId === chatAgentId(),
    isPresented: () => state.agentsPanel === "tools",
    key: (agentId, sessionKey) => buildToolsEffectiveRequestKey(state, { agentId, sessionKey }),
    changed: publish,
  });

  function applyRoute() {
    applyRouteData();
    if (!routeSelectionSuperseded) {
      normalizedLocation = syncAgentsCanonicalLocation(context, routeData, normalizedLocation);
    }
    ensureInitialData();
  }

  function syncGatewayState() {
    if (state.cron.client !== state.client || state.cron.connected !== state.connected) {
      // In-flight cron loaders mutate their captured state; same-client
      // snapshots must retain it or loading never clears in the visible state.
      cron.retire();
      state.cron = { ...state.cron, client: state.client, connected: state.connected };
    }
  }

  function canCall(method: string, requiredScope: GatewayMethodOperatorScope): boolean {
    return canCallGatewayMethod(context.gateway.snapshot, method, requiredScope);
  }

  function syncAgentState(agents = context.agents) {
    syncSettingsSelection();
    files.sync(agents);
  }

  function syncSettingsSelection() {
    const selection = context.settingsAgentSelection;
    const restoredIdentity = selectionDrafts.select({
      selectedId: selection.state.selectedId,
      profileId: context.gateway.snapshot.selfUser?.id ?? null,
    });
    if (restoredIdentity) {
      identity.schedule(0);
    }
    syncGitHubIdentity(state.agentsSelectedId);
  }

  function resetForSourceChange() {
    selectionDrafts.clear();
    identitySaves = selectionDrafts.bindContext(context);
    state.agentsSelectedId = null;
    resetSelectionState();
  }

  function invalidateTransientRequests() {
    presentation.retire();
    gateway.invalidate();
    files.invalidate();
    state.identitySaving = false;
    skills.reset();
    toolsCatalog.invalidate();
    effectiveTools.reset();
    cron.retire();
    state.cron = {
      ...state.cron,
      cronLoading: false,
      cronJobsLoadingMore: false,
      cronJobsReloadPending: false,
      cronJobsReloadPendingTableFilters: false,
      cronRunsLoadingMore: false,
      cronBusy: false,
    };
  }

  function applyRouteData() {
    const data = routeData;
    if (!data) {
      routeDataInitialized = false;
      return;
    }
    routeDataInitialized = true;
    const selection = context.settingsAgentSelection;
    const ownsIntent =
      data.settingsAgentSelection === selection &&
      data.selectionIntentRevision === selection.intentRevision;
    routeSelectionSuperseded = !ownsIntent;
    if (data.requestedAgentId && ownsIntent) {
      // Loaders and preloads only record URL intent. Apply it when the route commits,
      // unless a newer sidebar choice (including an ABA change) has superseded it.
      applyingRouteSelection = true;
      try {
        selection.set(data.requestedAgentId);
      } finally {
        applyingRouteSelection = false;
      }
    }
    syncSettingsSelection();
    if (!ownsIntent && data.requestedAgentId && state.agentsSelectedId) {
      context.replace("agents", {
        ...(data.canonicalLocation ?? data.location),
        pathname: pathForAgentPanel(
          state.agentsSelectedId,
          data.panel === DEFAULT_AGENT_PANEL ? null : data.panel,
          context.basePath,
        ),
      });
    }
  }

  function chatAgentId() {
    return (
      parseAgentSessionKey(state.sessionKey)?.agentId ??
      context.gateway.snapshot.assistantAgentId ??
      state.agentsList?.defaultId ??
      "main"
    );
  }

  function ensureInitialData() {
    if (!state.connected || !state.client || !routeDataInitialized || !routeData) {
      return;
    }
    void context.runtimeConfig.ensureLoaded();
    if (!state.agentsList && !context.agents.state.agentsLoading) {
      void refreshAgents("ensure");
      return;
    }
    ensureAgentIdentities();
    loadActivePanelData();
  }

  function isCurrentRequest(
    client: GatewayBrowserClient,
    generation: number,
    agentId: string | undefined,
    sources: Partial<Pick<ApplicationContext, "agents" | "agentIdentity">>,
  ): boolean {
    return (
      active &&
      state.client === client &&
      state.connected &&
      state.requestGeneration === generation &&
      (!sources.agents || context.agents === sources.agents) &&
      (!sources.agentIdentity || context.agentIdentity === sources.agentIdentity) &&
      (!agentId || state.agentsSelectedId === agentId)
    );
  }

  function ensureAgentIdentities() {
    void context.agentIdentity.ensure(
      listSelectableAgents(state.agentsList?.agents ?? []).map((entry) => entry.id),
    );
  }

  function loadActivePanelData() {
    // A reused page can receive a roster before its next route data commits.
    if (!routeData) {
      return;
    }
    const agentId = state.agentsSelectedId;
    if (!agentId) {
      return;
    }
    if (state.agentsPanel === "overview") {
      modelCatalog.ensure();
      return;
    }
    if (state.agentsPanel === "files" && state.agentFilesList?.agentId !== agentId) {
      void files.load(agentId);
      return;
    }
    if (state.agentsPanel === "skills" && state.agentSkillsAgentId !== agentId) {
      skills.refresh(agentId);
      return;
    }
    if (state.agentsPanel === "tools") {
      syncGitHubIdentity(agentId);
      toolsCatalog.ensure(agentId);
      effectiveTools.ensure();
      githubIdentity.ensureVerified();
      return;
    }
    if (state.agentsPanel === "channels" && !channelCapability.state.channelsSnapshot) {
      void channelCapability.refresh(false);
      return;
    }
    if (state.agentsPanel === "cron") {
      if (state.cron.cronAgentId !== agentId) {
        cron.retire();
        state.cron = createInitialCronState({
          client: state.client,
          connected: state.connected,
        });
        state.cron.cronAgentId = agentId;
      }
      if (!state.cron.cronLoading && !state.cron.cronStatus) {
        cron.onRefresh();
      }
    }
  }

  function syncGitHubIdentity(agentId: string | null) {
    const snapshot = context.gateway.snapshot;
    const profileId = snapshot.selfUser?.id ?? null;
    const hasScope = (method: string, scope: GatewayMethodOperatorScope) =>
      canCallGatewayMethod(snapshot, method, scope, { requireAdvertisement: false });
    githubIdentity.sync({
      client: state.client,
      connected: state.connected,
      permissionsReady: snapshot.phase === "connected" && Boolean(snapshot.hello),
      target: agentId
        ? {
            kind: "shared",
            scope: "agent",
            profileId,
            agentId,
            config: currentConfigObject(context.runtimeConfig.state),
          }
        : null,
      statusReadable: hasScope("tools.github.status", "operator.read"),
      configurable: hasScope("tools.github.configure", "operator.admin"),
      authorizable: [
        "tools.github.authorize.start",
        "tools.github.authorize.poll",
        "tools.github.authorize.cancel",
      ].every((method) => hasScope(method, "operator.admin")),
      clientRevision: state.requestGeneration,
    });
  }

  function resetSelectionState() {
    presentation.retire();
    identity.cancel();
    gateway.invalidate();
    modelCatalog.reset();
    files.reset();
    state.agentSkillsReport = null;
    skills.reset();
    state.agentSkillsAgentId = null;
    resetIdentityDraft(state);
    toolsCatalog.reset();
    effectiveTools.reset();
    cron.retire();
    state.cron = createInitialCronState({
      client: state.client,
      connected: state.connected,
    });
  }

  async function refreshAgents(mode: "ensure" | "refresh" | "save" = "refresh") {
    const client = state.client;
    if (!client || (mode === "save" && !canCall("config.set", "operator.admin"))) {
      return;
    }
    const generation = state.requestGeneration;
    const agents = context.agents;
    if (mode === "save" && !(await context.runtimeConfig.save())) {
      return;
    }
    await (mode === "ensure" ? agents.ensureList() : agents.refreshList());
    if (!isCurrentRequest(client, generation, undefined, { agents })) {
      return;
    }
    if (mode === "save") {
      effectiveTools.reset();
    }
    syncAgentState(agents);
    if (mode !== "refresh") {
      ensureAgentIdentities();
    }
    loadActivePanelData();
  }

  async function selectDefaultAgent(agentId: string) {
    const client = state.client;
    if (!client || !canCall("config.set", "operator.admin")) {
      return;
    }
    const generation = state.requestGeneration;
    const agents = context.agents;
    const runtimeConfig = context.runtimeConfig;
    const canDispatch = () =>
      context.runtimeConfig === runtimeConfig &&
      isCurrentRequest(client, generation, undefined, { agents }) &&
      canCall("config.set", "operator.admin");
    await runtimeConfig.ensureLoaded();
    if (!canDispatch()) {
      return;
    }
    return setDefaultAgent(runtimeConfig, agentId, () => agents.refreshList(), canDispatch);
  }

  function viewProps() {
    const configState = context.runtimeConfig.state;
    const selectedAgentId = state.agentsSelectedId;
    const access = {
      canCreateAgent: canCall("openclaw.chat", "operator.admin"),
      canPatchConfig: canCall("config.patch", "operator.admin"),
      canUpdateConfig: canCall("config.set", "operator.admin"),
      canUpdateIdentity: canCall("agents.update", "operator.admin"),
      canWriteFiles: canCall("agents.files.set", "operator.admin"),
      canRunCron: canCall("cron.run", "operator.admin"),
    };
    const catalog = modelCatalog.read();
    return {
      access,
      readData,
      presentationRetired: presentation.retired,
      readChannels,
      basePath: context.basePath,
      listRead: context.agents.listRead,
      selectedAgentId,
      memoryTarget,
      config: configState,
      channels: {
        onRefresh: () => void channelCapability.refresh(false),
      },
      cron: {
        read: cron.read,
        onRefresh: cron.onRefresh,
        onLoadMore: cron.onLoadMore,
        onRunNow: cron.onRunNow,
      },
      agentFiles: files.forAgent(selectedAgentId),
      agentIdentityById: Object.fromEntries(
        identities.read().map((entry) => [entry.agentId, entry]),
      ),
      overview: {
        modelCatalog: catalog.models,
        decisionModels: catalog.decisionModels ?? [],
        modelSelectionPolicy: catalog.modelSelectionPolicy,
        modelCatalogRetired: catalog.retired,
        modelCatalogHasSnapshot: catalog.hasSnapshot,
        modelCatalogGateway: context.gateway.snapshot,
        ...identity.forAgent(selectedAgentId),
        ...configActions.models,
        // Availability facts (provider keys added/removed, new models) go
        // stale in the per-agent cache; opening the picker re-reads them,
        // mirroring the chat composer's on-open refresh.
        onModelCatalogOpen: () => modelCatalog.ensure({ refresh: true }),
      },
      agentSkills: {
        get filter() {
          return skillsFilter();
        },
        onFilterChange: (next: string) => {
          setSkillsFilter(next);
        },
        onRefresh: () => {
          if (selectedAgentId) {
            skills.refresh(selectedAgentId);
          }
        },
        ...configActions.skills,
        onClear: (agentId: string) => skillReset.clear(agentId),
      },
      tools: {
        readCatalog: toolsCatalog.read,
        catalogRequest: toolsCatalog.request(),
        readEffective: effectiveTools.read,
        effectivePreview: effectiveTools.cached,
        effectiveRequest: effectiveTools.request(),
        onRetryCatalog: () => {
          if (state.agentsSelectedId) {
            toolsCatalog.ensure(state.agentsSelectedId);
          }
        },
        githubIdentity,
        onOpenGitHubConnections: () =>
          context.navigate("profile", { hash: "#settings-profile-github-connections" }),
        runtimeSessionKey: state.sessionKey,
        runtimeSessionMatchesSelectedAgent: selectedAgentId === chatAgentId(),
        ...configActions.tools,
      },
      pinnedAgentIds: navigation.read().pinnedAgentIds,
      onTogglePinnedAgent: (agentId: string) => togglePinnedAgent(context.navigation, agentId),
      onRefresh: () => void refreshAgents(),
      onCreateAgent: () => {
        if (canCall("openclaw.chat", "operator.admin")) {
          context.navigate("custodian", { search: "?intent=new-agent" });
        }
      },
      onSelectPanel: (panel: AgentsPanel) =>
        navigateToAgentPanel(context, selectedAgentId, state.agentsPanel, panel),
      onConfigReload: () => context.runtimeConfig.discardDraft({ reloadOnly: true }),
      onConfigSave: () => refreshAgents("save"),
      onOpenMemoryImport: () => context.navigate("memory-import"),
      onOpenMemorySettings: () => context.navigate("memory"),
      onOpenAgentDefaults: () => context.navigate("ai-agents"),
      onSetDefault: selectDefaultAgent,
    };
  }

  const memoryTarget: AgentMemoryTarget = {
    read: () => state.agentsSelectedId,
    subscribe: observation.subscribe,
  };
  onSettled(() => {
    gateway.connect();
    syncAgentState();
    ensureAgentIdentities();
    const selection = context.settingsAgentSelection;
    let intentRevision = selection.intentRevision;
    const stops = [
      context.gateway.subscribeEvents((event) => {
        if (hasCronInventoryEvents(context.gateway.snapshot)) {
          if (isCronInventoryInvalidation(event, context.gateway.snapshot)) {
            cron.onRefresh(false);
          } else if (event.event === "cron") {
            cron.onRuntime(event.payload);
          }
        }
      }),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState !== "hidden") {
          cron.onRefresh(false);
        }
      }),
      // Selection receipts transfer draft custody and retire prior-agent work synchronously.
      selection.subscribe(() => {
        const explicitSelection = selection.intentRevision !== intentRevision;
        intentRevision = selection.intentRevision;
        const previousId = state.agentsSelectedId;
        syncSettingsSelection();
        const agentId = state.agentsSelectedId;
        const route = context.router.getState();
        if (
          explicitSelection &&
          !applyingRouteSelection &&
          routeDataInitialized &&
          routeData &&
          agentId &&
          route.matches[0]?.routeId === "agents" &&
          (!route.pendingMatches.length || route.pendingMatches[0]?.routeId === "agents")
        ) {
          navigateToAgent(context, agentId, previousId, state.agentsPanel);
        }
        loadActivePanelData();
        publish();
      }),
      // Roster and file publications adopt metadata before dependent file reads can settle.
      context.agents.subscribe(() => {
        syncAgentState();
        ensureAgentIdentities();
        loadActivePanelData();
        publish();
      }),
      // Config receipts retire obsolete GitHub authorization before the next tool action.
      context.runtimeConfig.subscribe(() => {
        syncGitHubIdentity(state.agentsSelectedId);
        publish();
      }),
      // Local model receipts change the request key; unrelated roster publications reuse it.
      context.sessions.subscribe(() => {
        effectiveTools.ensure();
        publish();
      }),
      effectiveTools.subscribe(context.gateway),
    ];
    applyRoute();
    return () => {
      selectionDrafts.retainCurrentIdentity();
      identity.cancel();
      active = false;
      presentation.retire();
      cron.retire();
      observation.dispose();
      for (const stop of stops) {
        stop();
      }
      modelCatalog.reset();
      gateway.dispose();
    };
  });
  return {
    identitySavePending: () => identity.saving() || readData().identitySaving,
    read() {
      observation.read();
      return viewProps();
    },
    setRouteData(next?: AgentsRouteData) {
      if (next === routeData) {
        return;
      }
      if (next?.panel !== routeData?.panel) {
        presentation.retire();
      }
      routeData = next;
      applyRoute();
      publish();
    },
  };
}
