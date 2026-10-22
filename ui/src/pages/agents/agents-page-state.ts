import { createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesListResult } from "../../api/types.ts";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import { togglePinnedAgent } from "../../app/bootstrap-navigation-preferences.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import { buildToolsEffectiveRequestKey, type AgentsState } from "../../lib/agents/index.ts";
import { setDefaultAgent } from "../../lib/agents/mutations.ts";
import { DEFAULT_AGENT_PANEL, type AgentsPanel } from "../../lib/agents/panels.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import {
  canCallGatewayMethod,
  type GatewayMethodOperatorScope,
} from "../../lib/gateway-methods.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { ModelCatalogReader } from "../../lib/model-catalog-reader.ts";
import { modelCatalogRefreshError, readAgentModelCatalog } from "../../lib/model-catalog-store.ts";
import { createGitHubIdentityView } from "../../lib/reactive/domain-github-identity.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { createAgentConfigActions } from "./agent-config-actions.ts";
import { createAgentCronPresenter } from "./agent-cron-presenter.ts";
import { createAgentsPageLifetime } from "./agents-page-lifetime.ts";
import type { GeneratedAvatar } from "./avatar-picker.tsx";
import {
  loadAgentFileContent,
  createAgentFileActions,
  resetAgentFiles,
  type AgentFilesState,
} from "./files.ts";
import {
  type AgentIdentityDraft,
  resetIdentityDraft,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityAvatar,
  setIdentityDraftField,
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

type AgentsPageData = Omit<AgentsState, "agentsLoading" | "agentsError"> &
  AgentFilesState &
  AgentSkillsState & {
    chatModelCatalogRead: Promise<void> | null;
    agentFilesList: AgentsFilesListResult | null;
    agentFileActive: string | null;
    identityDraft: AgentIdentityDraft;
    identitySaving: boolean;
    identityError: string | null;
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
  const [skillsFilter, setSkillsFilter] = createSignal("");
  const identities = projectOwner(context.agentIdentity, (identity) => identity.entries());
  const channels = projectOwner(context.channels, (source) => source.state);
  const navigation = projectOwner(context.navigation, (source) => source.snapshot);
  // The domain helpers mutate then read their state synchronously; Solid only observes it.
  const observation = observeState<AgentsPageData>({
    agentsList: null,
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
    identityError: null,
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
    canCall: (method, scope) => active && canCall(method, scope),
    publish,
  });
  const selectionDrafts = createAgentSelectionDrafts(state, resetSelectionState);
  let identitySaves = selectionDrafts.bindContext(context);
  let identityAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
  const presentation = createAgentsPageLifetime();
  const skills = createAgentSkillsReader(state);
  const skillReset = createAgentSkillsReset({
    retired: presentation.retired,
    state,
    context,
    canReset: () => canCall("config.patch", "operator.admin"),
    isCurrent: (client, generation, agentId, agents) =>
      isCurrentRequest(client, generation, agentId, { agents }),
    onUpdated: (agentId) => skills.refresh(agentId),
  });
  let catalogRecoveryPending = false;
  let catalogNeedsRecovery = false;
  const modelReader = new ModelCatalogReader(publish, {
    onRead: (read) => {
      const completion = read.then((result) => {
        const error = result && modelCatalogRefreshError(result);
        if (error) {
          throw new Error(error);
        }
      });
      // The notice can be absent while another agent panel is selected.
      void completion.catch(() => undefined);
      state.chatModelCatalogRead = completion;
    },
    onResult: (result) => settleModelCatalog(Boolean(modelCatalogRefreshError(result))),
    onError: () => settleModelCatalog(true),
  });
  let routeDataInitialized = false;
  let applyingRouteSelection = false;
  let routeSelectionSuperseded = false;
  let normalizedLocation = "";
  const configActions = createAgentConfigActions({
    getRuntimeConfig: () => context.runtimeConfig,
    canUpdate: (agentId: string) =>
      agentId === state.agentsSelectedId && canCall("config.set", "operator.admin"),
    getReport: () => state.agentSkillsReport,
    onPrimaryChanged: () => refreshEffectiveToolsForCurrentSession(),
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
      resetModelCatalog();
    },
    onSnapshot: ({ snapshot: gatewaySnapshot, becameAvailable, becameConnected }) => {
      identitySaves = selectionDrafts.bindContext(context);
      selectionDrafts.observeGateway(gatewaySnapshot);
      syncGatewayState();
      if (becameConnected && Object.values(state.identityDraft).some((value) => value !== null)) {
        scheduleIdentitySave();
      }
      syncGitHubIdentity(state.agentsSelectedId);
      if (becameAvailable && !becameConnected) {
        if (modelReader.pending) {
          catalogRecoveryPending = true;
        } else {
          recoverModelCatalog();
        }
      }
    },
    ensureInitialData: () => ensureInitialData(),
  });
  const isCurrentToolsRead = (client: GatewayBrowserClient, generation: number, agentId: string) =>
    isCurrentRequest(client, generation, agentId, {});
  const toolsCatalog = createAgentToolsCatalog({
    scope: () => state,
    isCurrent: isCurrentToolsRead,
  });
  const effectiveTools = createAgentEffectiveTools({
    scope: () => state,
    isCurrent: isCurrentToolsRead,
    key: (agentId, sessionKey) => buildToolsEffectiveRequestKey(state, { agentId, sessionKey }),
    changed: publish,
  });

  function applyRoute() {
    applyRouteData();
    syncCanonicalLocation();
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
    const agentState = agents.state;
    state.agentsList = agentState.agentsList ? selectableAgentsList(agentState.agentsList) : null;
    syncSettingsSelection();
    syncCurrentAgentFiles(agents);
  }

  function syncSettingsSelection() {
    const selection = context.settingsAgentSelection;
    const restoredIdentity = selectionDrafts.select({
      selectedId: selection.state.selectedId,
      profileId: context.gateway.snapshot.selfUser?.id ?? null,
    });
    if (restoredIdentity) {
      scheduleIdentitySave(0);
    }
    syncGitHubIdentity(state.agentsSelectedId);
  }

  function syncCurrentAgentFiles(agents = context.agents) {
    const agentId = state.agentsSelectedId;
    if (!agentId || state.agentsPanel !== "files") {
      return;
    }
    const status = agents.files(agentId);
    if (!status.list) {
      return;
    }
    state.agentFilesList = status.list;
    void selectDefaultAgentFile(agentId);
  }

  async function selectDefaultAgentFile(agentId: string, force = false) {
    const files = state.agentFilesList?.files ?? [];
    if (!state.agentFileActive || !files.some((file) => file.name === state.agentFileActive)) {
      state.agentFileActive = files.find((file) => file.name === "AGENTS.md")?.name ?? null;
    }
    if (state.agentFileActive && !context.agents.files(agentId).loading) {
      await loadAgentFileContent(state, agentId, state.agentFileActive, {
        force,
      });
    }
  }

  function resetForSourceChange() {
    clearIdentityAutosave();
    selectionDrafts.clear();
    identitySaves = selectionDrafts.bindContext(context);
    state.agentsList = null;
    state.agentsSelectedId = null;
    resetSelectionState();
  }

  function invalidateTransientRequests() {
    presentation.retire();
    gateway.invalidate();
    state.agentFilesLoading = false;
    state.agentFileRead = null;
    state.agentFileOutcome = null;
    state.agentFileSaving = false;
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
    if (gateway.isRouteDataCurrent(data) && data.agentsList) {
      state.agentsList = data.agentsList;
    }
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

  function syncCanonicalLocation() {
    if (routeSelectionSuperseded) {
      return;
    }
    normalizedLocation = syncAgentsCanonicalLocation(context, routeData, normalizedLocation);
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
    if (!context.runtimeConfig.state.configSnapshot && !context.runtimeConfig.state.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
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
    void context.agentIdentity.ensure(state.agentsList?.agents.map((entry) => entry.id) ?? []);
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
      ensureModelCatalog();
      return;
    }
    if (state.agentsPanel === "files" && state.agentFilesList?.agentId !== agentId) {
      void loadAgentFiles(agentId);
      return;
    }
    if (state.agentsPanel === "skills" && state.agentSkillsAgentId !== agentId) {
      skills.refresh(agentId);
      return;
    }
    if (state.agentsPanel === "tools") {
      syncGitHubIdentity(agentId);
      toolsCatalog.ensure(agentId);
      loadEffectiveToolsForAgent(agentId);
      githubIdentity.ensureVerified();
      return;
    }
    if (state.agentsPanel === "channels" && !context.channels.state.channelsSnapshot) {
      void context.channels.refresh(false);
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

  function resetModelCatalog() {
    modelReader.clear();
    catalogRecoveryPending = false;
    catalogNeedsRecovery = false;
    state.chatModelCatalogRead = null;
  }

  function settleModelCatalog(needsRecovery: boolean) {
    catalogNeedsRecovery = needsRecovery;
    if (catalogRecoveryPending) {
      catalogRecoveryPending = false;
      recoverModelCatalog();
    }
  }

  function recoverModelCatalog() {
    if (isGatewayAvailable(context.gateway.snapshot) && catalogNeedsRecovery) {
      ensureModelCatalog({ refresh: true });
    }
  }

  function ensureModelCatalog(options: { refresh?: boolean } = {}) {
    const agentId = state.agentsSelectedId;
    if (!state.client || !state.connected || !agentId) {
      return;
    }
    if (modelReader.bind(context.gateway, { agentId })) {
      catalogNeedsRecovery = false;
      state.chatModelCatalogRead = null;
    }
    if (
      !modelReader.pending &&
      (options.refresh || !state.chatModelCatalogRead || modelReader.failed)
    ) {
      void modelReader.read();
    }
  }

  async function loadAgentFiles(agentId: string, force = false) {
    const client = state.client;
    const agents = context.agents;
    const cached = agents.files(agentId);
    if (!client || !state.connected || state.agentFilesLoading || cached.loading) {
      return;
    }
    if (cached.list && !force) {
      syncCurrentAgentFiles(agents);
      return;
    }
    // Keep an initial failure visible until explicit retry or owner retirement.
    if (cached.read && !force) {
      return;
    }
    const generation = state.requestGeneration;
    state.agentFileOutcome = null;
    const list = force ? await agents.refreshFiles(agentId) : await agents.ensureFiles(agentId);
    if (!isCurrentRequest(client, generation, agentId, { agents })) {
      return;
    }
    state.agentFilesList = list ?? agents.files(agentId).list;
    if (list) {
      await selectDefaultAgentFile(agentId, force);
    }
  }

  function clearIdentityAutosave() {
    if (identityAutosaveTimer !== null) {
      clearTimeout(identityAutosaveTimer);
      identityAutosaveTimer = null;
    }
  }

  function scheduleIdentitySave(delay = 550) {
    clearIdentityAutosave();
    const { name, emoji, avatar } = state.identityDraft;
    if (
      (name !== null && !name.trim()) ||
      (emoji !== null && !emoji.trim()) ||
      (name === null && emoji === null && avatar === null)
    ) {
      return;
    }
    identityAutosaveTimer = setTimeout(() => {
      identityAutosaveTimer = null;
      void saveSelectedIdentity();
    }, delay);
  }

  async function saveSelectedIdentity() {
    if (!canCall("agents.update", "operator.admin")) {
      return;
    }
    const client = state.client;
    const agentId = state.agentsSelectedId;
    if (!client || !agentId) {
      return;
    }
    const activeSave = identitySaves.get(agentId);
    if (activeSave?.client === client && activeSave.snapshot === gateway.snapshot) {
      await activeSave.promise;
      if (state.client === client && state.agentsSelectedId === agentId) {
        scheduleIdentitySave(0);
      }
      return;
    }
    if (state.identitySaving) {
      return;
    }
    const generation = state.requestGeneration;
    const agents = context.agents;
    const agentIdentity = context.agentIdentity;
    const draftAtStart = state.identityDraft;
    const save = saveIdentityDraft({
      host: state,
      config: context.config,
      expectedClient: client,
      agentId,
      agents,
      agentIdentity,
      runtimeConfig: context.runtimeConfig,
      canDispatch: () =>
        canCall("agents.update", "operator.admin") &&
        isCurrentRequest(client, generation, agentId, { agents, agentIdentity }),
      isCurrent: () => isCurrentRequest(client, generation, agentId, { agents, agentIdentity }),
      onSaved: () => syncAgentState(agents),
    });
    identitySaves.set(agentId, { client, snapshot: gateway.snapshot, promise: save });
    try {
      await save;
    } finally {
      if (identitySaves.get(agentId)?.promise === save) {
        identitySaves.delete(agentId);
      }
    }
    if (
      isCurrentRequest(client, generation, agentId, { agents, agentIdentity }) &&
      state.identityDraft !== draftAtStart
    ) {
      scheduleIdentitySave(0);
    }
  }

  function resetSelectionState() {
    presentation.retire();
    clearIdentityAutosave();
    gateway.invalidate();
    resetModelCatalog();
    resetAgentFiles(state);
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

  function loadEffectiveToolsForAgent(agentId: string, refresh = false) {
    if (agentId !== chatAgentId()) {
      effectiveTools.reset();
      return;
    }
    effectiveTools.ensure(agentId, state.sessionKey, refresh);
  }

  function refreshEffectiveToolsForCurrentSession() {
    const agentId = state.agentsSelectedId;
    if (state.agentsPanel === "tools" && agentId) {
      loadEffectiveToolsForAgent(agentId, true);
    }
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
    const canEditIdentity = () =>
      selectedAgentId === state.agentsSelectedId && canCall("agents.update", "operator.admin");
    const access = {
      canCreateAgent: canCall("openclaw.chat", "operator.admin"),
      canPatchConfig: canCall("config.patch", "operator.admin"),
      canUpdateConfig: canCall("config.set", "operator.admin"),
      canUpdateIdentity: canCall("agents.update", "operator.admin"),
      canWriteFiles: canCall("agents.files.set", "operator.admin"),
      canRunCron: canCall("cron.run", "operator.admin"),
    };
    const modelCatalog = readAgentModelCatalog(
      state.connected ? state.client : null,
      state.agentsSelectedId,
    );
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
        onRefresh: () => void context.channels.refresh(false),
      },
      cron: {
        read: cron.read,
        onRefresh: cron.onRefresh,
        onLoadMore: cron.onLoadMore,
        onRunNow: cron.onRunNow,
      },
      agentFiles: {
        listRead: context.agents.files(selectedAgentId).read,
        onLoadFiles: (agentId: string) => void loadAgentFiles(agentId, true),
        ...createAgentFileActions(state, selectedAgentId, () =>
          canCall("agents.files.set", "operator.admin"),
        ),
      },
      agentIdentityById: Object.fromEntries(
        identities.read().map((entry) => [entry.agentId, entry]),
      ),
      overview: {
        modelCatalog: modelCatalog.models,
        decisionModels: modelCatalog.decisionModels ?? [],
        modelSelectionPolicy: modelCatalog.modelSelectionPolicy,
        modelCatalogRetired: modelCatalog.retired,
        modelCatalogHasSnapshot: modelCatalog.hasSnapshot,
        modelCatalogGateway: context.gateway.snapshot,
        onIdentityFieldChange: (field: "name" | "emoji", value: string) => {
          if (canEditIdentity()) {
            setIdentityDraftField(state, field, value);
            scheduleIdentitySave();
          }
        },
        onIdentityAvatarSelect: (file: File) => {
          if (canEditIdentity()) {
            selectIdentityAvatar(state, file, context.config, () => scheduleIdentitySave(0));
          }
        },
        onIdentityAvatarSet: (dataUrl: string) => {
          if (canEditIdentity()) {
            setIdentityAvatar(state, dataUrl, context.config);
            scheduleIdentitySave(0);
          }
        },
        onIdentityAvatarGenerate: async (prompt: string) => {
          const client = state.client;
          const generation = state.requestGeneration;
          if (
            !client ||
            !selectedAgentId ||
            !canEditIdentity() ||
            !canCall("agents.avatar.generate", "operator.admin")
          ) {
            throw new Error(t("agents.identity.avatarPermission"));
          }
          const result = await client.request<GeneratedAvatar>(
            "agents.avatar.generate",
            { agentId: selectedAgentId, prompt },
            { timeoutMs: 100_000 },
          );
          if (!isCurrentRequest(client, generation, selectedAgentId, {})) {
            throw new Error(t("agents.identity.avatarContextChanged"));
          }
          return result;
        },
        onIdentitySave: () => scheduleIdentitySave(0),
        ...configActions.models,
        // Availability facts (provider keys added/removed, new models) go
        // stale in the per-agent cache; opening the picker re-reads them,
        // mirroring the chat composer's on-open refresh.
        onModelCatalogOpen: () => ensureModelCatalog({ refresh: true }),
      },
      agentSkills: {
        filter: skillsFilter(),
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
      // Session model receipts replace the tools.effective request key before older results settle.
      context.sessions.subscribe(() => {
        refreshEffectiveToolsForCurrentSession();
        publish();
      }),
    ];
    applyRoute();
    return () => {
      selectionDrafts.retainCurrentIdentity();
      clearIdentityAutosave();
      active = false;
      presentation.retire();
      cron.retire();
      observation.dispose();
      for (const stop of stops) {
        stop();
      }
      resetModelCatalog();
      gateway.dispose();
    };
  });
  return {
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
