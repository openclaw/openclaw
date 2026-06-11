import type { AppViewState } from "./app-view-state.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import {
  buildToolsEffectiveRequestKey,
  loadAgents,
  loadAgentsRuntimeStatus,
  loadOpsSummary,
  loadToolsCatalog,
  loadToolsEffective,
  resetToolsEffectiveState,
  refreshVisibleToolsEffectiveForCurrentSession,
  saveAgentsConfig,
} from "./controllers/agents.ts";
import { loadChannels } from "./controllers/channels.ts";
import {
  ensureAgentConfigEntry,
  findAgentConfigEntryIndex,
  loadConfig,
  removeConfigFormValue,
  stageDefaultAgentConfigEntry,
  updateConfigFormValue,
} from "./controllers/config.ts";
import { loadKalshiDashboard } from "./controllers/kalshi-dashboard.ts";
import {
  runSelfImprovementAnalysis,
  loadSelfImprovementRecommendations,
  runSelfImprovementMaintenanceDryRun,
  runSelfImprovementModelPreflight,
  runSelfImprovementProductionCheck,
  runSelfImprovementScan,
  updateSelfImprovementCuratorProposal,
  updateSelfImprovementGroup,
  updateSelfImprovementRecommendation,
} from "./controllers/self-improvement.ts";
import type { Tab } from "./navigation.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import {
  resolveAgentConfig,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
} from "./views/agents-utils.ts";
import { saveAgentWorkflowOrders } from "./views/agents-workflows-state.ts";
import { renderAgents } from "./views/agents.ts";

export function renderAgentsTab(state: AppViewState, configValue: Record<string, unknown> | null) {
  const resolveSelectedAgentId = () =>
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const resolvedAgentId = resolveSelectedAgentId();
  const activeSessionAgentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const toolsPanelUsesActiveSession = Boolean(
    resolvedAgentId && activeSessionAgentId && resolvedAgentId === activeSessionAgentId,
  );
  const agentsRoomNeedsOpsSummary =
    (state.tab === "agents" || state.tab === "agentWorkflows") &&
    (state.agentsPanel === "room" || state.agentsPanel === "workflows") &&
    state.connected &&
    !state.opsSummary &&
    !state.opsSummaryLoading &&
    !state.opsSummaryError;
  if (agentsRoomNeedsOpsSummary) {
    queueMicrotask(() => {
      if (
        state.connected &&
        !state.opsSummary &&
        !state.opsSummaryLoading &&
        !state.opsSummaryError
      ) {
        void loadOpsSummary(state);
      }
    });
  }
  const getCurrentConfigValue = () =>
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const findAgentIndex = (agentId: string) =>
    findAgentConfigEntryIndex(getCurrentConfigValue(), agentId);
  const ensureAgentIndex = (agentId: string) => ensureAgentConfigEntry(state, agentId);
  const resolveAgentToolsPath = (agentId: string, ensure: boolean) => {
    const index = ensure ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
    return index >= 0 ? (["agents", "list", index, "tools"] as const) : null;
  };
  const resolveAgentModelFormEntry = (index: number) => {
    const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)?.agents
      ?.list;
    const existing = Array.isArray(list)
      ? (list[index] as { model?: unknown } | undefined)?.model
      : undefined;
    return {
      basePath: ["agents", "list", index, "model"] as Array<string | number>,
      existing,
    };
  };
  const loadAgentPanelDataForSelectedAgent = (agentId: string | null) => {
    if (!agentId) {
      return;
    }
    switch (state.agentsPanel) {
      case "room":
        void loadAgentsRuntimeStatus(state);
        return;
      case "workflows":
        return;
      case "files":
        void loadAgentFiles(state, agentId);
        return;
      case "skills":
        void loadAgentSkills(state, agentId);
        return;
      case "tools":
        void loadToolsCatalog(state, agentId);
        void refreshVisibleToolsEffectiveForCurrentSession(state);
        return;
      case "overview":
      case "channels":
      case "cron":
      case "self-improvement":
        return;
    }
  };
  const refreshAgentsPanelSupplementalData = (panel: AppViewState["agentsPanel"]) => {
    if (panel === "channels") {
      void loadChannels(state, false);
      return;
    }
    if (panel === "room") {
      void loadAgentsRuntimeStatus(state);
      void loadOpsSummary(state);
      void loadKalshiDashboard(state, { view: "workspace" });
      return;
    }
    if (panel === "workflows") {
      void loadKalshiDashboard(state, { view: "workspace" });
      return;
    }
    if (panel === "cron") {
      void state.loadCron();
      return;
    }
    if (panel === "self-improvement") {
      void loadSelfImprovementRecommendations(state);
    }
  };
  const promptForSelfImprovementText = (message: string): string | null => {
    if (typeof globalThis.prompt !== "function") {
      return null;
    }
    const value = globalThis.prompt(message);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  const confirmSelfImprovementAction = (message: string): boolean =>
    typeof globalThis.confirm === "function" ? globalThis.confirm(message) : true;
  const resetAgentFilesState = (clearLoading = false) => {
    state.agentFilesList = null;
    state.agentFilesError = null;
    state.agentFileActive = null;
    state.agentFileContents = {};
    state.agentFileDrafts = {};
    if (clearLoading) {
      state.agentFilesLoading = false;
    }
  };
  const resetAgentSelectionPanelState = () => {
    resetAgentFilesState(true);
    state.agentSkillsReport = null;
    state.agentSkillsError = null;
    state.agentSkillsAgentId = null;
    state.toolsCatalogResult = null;
    state.toolsCatalogError = null;
    state.toolsCatalogLoading = false;
    resetToolsEffectiveState(state);
  };

  return renderAgents({
    basePath: state.basePath ?? "",
    loading: state.agentsLoading,
    error: state.agentsError,
    connected: state.connected,
    agentsList: state.agentsList,
    selectedAgentId: resolvedAgentId,
    activePanel: state.agentsPanel,
    config: {
      form: configValue,
      loading: state.configLoading,
      saving: state.configSaving,
      dirty: state.configFormDirty,
    },
    channels: {
      snapshot: state.channelsSnapshot,
      loading: state.channelsLoading,
      error: state.channelsError,
      lastSuccess: state.channelsLastSuccess,
    },
    cron: {
      status: state.cronStatus,
      jobs: state.cronJobs,
      loading: state.cronLoading,
      error: state.cronError,
    },
    agentFiles: {
      list: state.agentFilesList,
      loading: state.agentFilesLoading,
      error: state.agentFilesError,
      active: state.agentFileActive,
      contents: state.agentFileContents,
      drafts: state.agentFileDrafts,
      saving: state.agentFileSaving,
    },
    agentIdentityLoading: state.agentIdentityLoading,
    agentIdentityError: state.agentIdentityError,
    agentIdentityById: state.agentIdentityById,
    agentSkills: {
      report: state.agentSkillsReport,
      loading: state.agentSkillsLoading,
      error: state.agentSkillsError,
      agentId: state.agentSkillsAgentId,
      filter: state.skillsFilter,
    },
    toolsCatalog: {
      loading: state.toolsCatalogLoading,
      error: state.toolsCatalogError,
      result: state.toolsCatalogResult,
    },
    toolsEffective: {
      loading: state.toolsEffectiveLoading,
      error: state.toolsEffectiveError,
      result: state.toolsEffectiveResult,
    },
    sessions: {
      loading: state.sessionsLoading,
      error: state.sessionsError,
      result: state.sessionsResult,
    },
    runtimeStatus: {
      loading: state.agentsRuntimeLoading,
      error: state.agentsRuntimeError,
      result: state.agentsRuntimeStatus,
    },
    opsSummary: {
      loading: state.opsSummaryLoading,
      error: state.opsSummaryError,
      result: state.opsSummary,
    },
    selfImprovement: {
      loading: state.selfImprovementLoading,
      error: state.selfImprovementError,
      recommendations: state.selfImprovementRecommendations,
      groups: state.selfImprovementGroups,
      scorecard: state.selfImprovementScorecard,
      scorecards: state.selfImprovementScorecards,
      health: state.selfImprovementHealth,
      proposals: state.selfImprovementProposals,
      auditEvents: state.selfImprovementAuditEvents,
      total: state.selfImprovementTotal,
      scanLoading: state.selfImprovementScanLoading,
      lastScan: state.selfImprovementLastScan,
      analysisLoading: state.selfImprovementAnalysisLoading,
      lastAnalysis: state.selfImprovementLastAnalysis,
      modelPreflightLoading: state.selfImprovementModelPreflightLoading,
      lastModelPreflight: state.selfImprovementLastModelPreflight,
      productionCheckLoading: state.selfImprovementProductionCheckLoading,
      lastProductionCheck: state.selfImprovementLastProductionCheck,
      maintenanceLoading: state.selfImprovementMaintenanceLoading,
      lastMaintenance: state.selfImprovementLastMaintenance,
    },
    workflowMaps: {
      selectedRoomId: state.agentsWorkflowRoomId,
      selectedStepId: state.agentsWorkflowStepId,
      orders: state.agentsWorkflowOrders,
    },
    kalshiDashboard: state.kalshiDashboard,
    kalshiDashboardLoading: state.kalshiDashboardLoading,
    kalshiDashboardError: state.kalshiDashboardError,
    runtimeSessionKey: state.sessionKey,
    runtimeSessionMatchesSelectedAgent: toolsPanelUsesActiveSession,
    modelCatalog: state.chatModelCatalog ?? [],
    onAttentionAction: (target) => {
      if (target.kind === "appTab") {
        state.setTab(target.tab as Tab);
        return;
      }
      if (target.kind === "channelStart") {
        const accountSuffix = target.accountId ? ` (${target.accountId})` : "";
        const confirmed =
          typeof globalThis.confirm === "function"
            ? globalThis.confirm(
                `Retry the ${target.channel}${accountSuffix} channel connection now?`,
              )
            : true;
        if (!confirmed || !state.client || !state.connected) {
          return;
        }
        state.setTab("channels");
        void state.client
          .request("channels.start", {
            channel: target.channel,
            accountId: target.accountId ?? undefined,
          })
          .finally(() => {
            void loadChannels(state, true);
            void loadOpsSummary(state);
          });
      }
    },
    onRefresh: async () => {
      await loadAgents(state);
      if (state.agentsPanel === "room") {
        void loadOpsSummary(state);
        void loadKalshiDashboard(state, { view: "workspace" });
      }
      const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
      if (agentIds.length > 0) {
        void loadAgentIdentities(state, agentIds);
      }
      loadAgentPanelDataForSelectedAgent(resolveSelectedAgentId());
      refreshAgentsPanelSupplementalData(state.agentsPanel);
    },
    onSelectAgent: (agentId) => {
      if (state.agentsSelectedId === agentId) {
        return;
      }
      state.agentsSelectedId = agentId;
      resetAgentSelectionPanelState();
      void loadAgentIdentity(state, agentId);
      loadAgentPanelDataForSelectedAgent(agentId);
    },
    onSelectPanel: (panel) => {
      state.agentsPanel = panel;
      if (
        panel === "files" &&
        resolvedAgentId &&
        state.agentFilesList?.agentId !== resolvedAgentId
      ) {
        resetAgentFilesState();
        void loadAgentFiles(state, resolvedAgentId);
      }
      if (panel === "skills" && resolvedAgentId) {
        void loadAgentSkills(state, resolvedAgentId);
      }
      if (panel === "tools" && resolvedAgentId) {
        if (state.toolsCatalogResult?.agentId !== resolvedAgentId || state.toolsCatalogError) {
          void loadToolsCatalog(state, resolvedAgentId);
        }
        if (resolvedAgentId === resolveAgentIdFromSessionKey(state.sessionKey)) {
          const toolsRequestKey = buildToolsEffectiveRequestKey(state, {
            agentId: resolvedAgentId,
            sessionKey: state.sessionKey,
          });
          if (state.toolsEffectiveResultKey !== toolsRequestKey || state.toolsEffectiveError) {
            void loadToolsEffective(state, {
              agentId: resolvedAgentId,
              sessionKey: state.sessionKey,
            });
          }
        } else {
          resetToolsEffectiveState(state);
        }
      }
      refreshAgentsPanelSupplementalData(panel);
    },
    onWorkflowRoomSelect: (roomId) => {
      state.agentsWorkflowRoomId = roomId;
      state.agentsWorkflowStepId = null;
    },
    onWorkflowStepSelect: (stepId) => {
      state.agentsWorkflowStepId = stepId;
    },
    onWorkflowOrderChange: (roomId, order) => {
      const next = { ...state.agentsWorkflowOrders, [roomId]: order };
      state.agentsWorkflowOrders = next;
      saveAgentWorkflowOrders(next);
    },
    onWorkflowResetRoom: (roomId) => {
      const next = { ...state.agentsWorkflowOrders };
      delete next[roomId];
      state.agentsWorkflowOrders = next;
      state.agentsWorkflowStepId = null;
      saveAgentWorkflowOrders(next);
    },
    onAssignAgentRoom: (agentId, roomId) => {
      if (!state.client || !state.connected || !agentId.trim() || !roomId.trim()) {
        return;
      }
      void state.client
        .request("agents.update", { agentId, roomId })
        .then(async () => {
          await loadAgents(state);
        })
        .catch((err) => {
          state.agentsError = String(err);
        });
    },
    onLoadFiles: (agentId) => loadAgentFiles(state, agentId),
    onSelectFile: (name) => {
      state.agentFileActive = name;
      if (!resolvedAgentId) {
        return;
      }
      void loadAgentFileContent(state, resolvedAgentId, name);
    },
    onFileDraftChange: (name, content) => {
      state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
    },
    onFileReset: (name) => {
      const base = state.agentFileContents[name] ?? "";
      state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
    },
    onFileSave: (name) => {
      if (!resolvedAgentId) {
        return;
      }
      const content = state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
      void saveAgentFile(state, resolvedAgentId, name, content);
    },
    onToolsProfileChange: (agentId, profile, clearAllow) => {
      const basePath = resolveAgentToolsPath(agentId, Boolean(profile || clearAllow));
      if (!basePath) {
        return;
      }
      if (profile) {
        updateConfigFormValue(state, [...basePath, "profile"], profile);
      } else {
        removeConfigFormValue(state, [...basePath, "profile"]);
      }
      if (clearAllow) {
        removeConfigFormValue(state, [...basePath, "allow"]);
      }
    },
    onToolsOverridesChange: (agentId, alsoAllow, deny) => {
      const basePath = resolveAgentToolsPath(agentId, alsoAllow.length > 0 || deny.length > 0);
      if (!basePath) {
        return;
      }
      if (alsoAllow.length > 0) {
        updateConfigFormValue(state, [...basePath, "alsoAllow"], alsoAllow);
      } else {
        removeConfigFormValue(state, [...basePath, "alsoAllow"]);
      }
      if (deny.length > 0) {
        updateConfigFormValue(state, [...basePath, "deny"], deny);
      } else {
        removeConfigFormValue(state, [...basePath, "deny"]);
      }
    },
    onConfigReload: () => loadConfig(state, { discardPendingChanges: true }),
    onConfigSave: () => saveAgentsConfig(state),
    onChannelsRefresh: () => loadChannels(state, false),
    onCronRefresh: () => state.loadCron(),
    onCronRunNow: (jobId) => {
      const job = state.cronJobs.find((entry) => entry.id === jobId);
      if (!job) {
        return;
      }
      void import("./controllers/cron.ts").then((m) => m.runCronJob(state, job, "force"));
    },
    onSelfImprovementRefresh: () => {
      void loadSelfImprovementRecommendations(state);
    },
    onSelfImprovementScan: () => {
      void runSelfImprovementScan(state);
    },
    onSelfImprovementAnalysis: () => {
      void runSelfImprovementAnalysis(state);
    },
    onSelfImprovementModelPreflight: () => {
      void runSelfImprovementModelPreflight(state);
    },
    onSelfImprovementProductionCheck: () => {
      void runSelfImprovementProductionCheck(state);
    },
    onSelfImprovementMaintenanceDryRun: () => {
      void runSelfImprovementMaintenanceDryRun(state);
    },
    onSelfImprovementRecommendationUpdate: (input) => {
      const status = input.status;
      if (status === "dismissed" && !input.dismissalReason) {
        const reason = promptForSelfImprovementText("Dismissal reason");
        if (!reason) {
          return;
        }
        void updateSelfImprovementRecommendation(state, { ...input, dismissalReason: reason });
        return;
      }
      if ((status === "resolved" || input.resolutionProof === "") && !input.resolutionProof) {
        const proof = promptForSelfImprovementText("Verification or approval proof");
        if (!proof) {
          return;
        }
        void updateSelfImprovementRecommendation(state, { ...input, resolutionProof: proof });
        return;
      }
      if (input.claimedBy === "") {
        const claimedBy = promptForSelfImprovementText("Claimed by");
        if (!claimedBy) {
          return;
        }
        void updateSelfImprovementRecommendation(state, { ...input, claimedBy });
        return;
      }
      void updateSelfImprovementRecommendation(state, input);
    },
    onSelfImprovementGroupUpdate: (input) => {
      if (
        input.status === "resolved" &&
        !confirmSelfImprovementAction("Resolve this entire recommendation group with proof?")
      ) {
        return;
      }
      if (
        input.status === "dismissed" &&
        !confirmSelfImprovementAction("Dismiss this entire recommendation group?")
      ) {
        return;
      }
      if (input.status === "dismissed" && !input.dismissalReason) {
        const reason = promptForSelfImprovementText("Group dismissal reason");
        if (!reason) {
          return;
        }
        void updateSelfImprovementGroup(state, { ...input, dismissalReason: reason });
        return;
      }
      if ((input.status === "resolved" || input.resolutionProof === "") && !input.resolutionProof) {
        const proof = promptForSelfImprovementText("Group verification or approval proof");
        if (!proof) {
          return;
        }
        void updateSelfImprovementGroup(state, { ...input, resolutionProof: proof });
        return;
      }
      void updateSelfImprovementGroup(state, input);
    },
    onSelfImprovementCuratorUpdate: (input) => {
      if (
        input.curatorStatus === "promoted" &&
        !confirmSelfImprovementAction("Record promotion proof for this memory/skill proposal?")
      ) {
        return;
      }
      if (input.proof === "") {
        const proof = promptForSelfImprovementText("Curator review or promotion proof");
        if (!proof) {
          return;
        }
        input = { ...input, proof };
      }
      if (input.reason === "") {
        const reason = promptForSelfImprovementText("Curator reason");
        if (!reason) {
          return;
        }
        input = { ...input, reason };
      }
      if (input.workshopProposalId === "") {
        const workshopProposalId = promptForSelfImprovementText("Skill Workshop proposal id");
        if (!workshopProposalId) {
          return;
        }
        input = { ...input, workshopProposalId };
      }
      void updateSelfImprovementCuratorProposal(state, input);
    },
    onSkillsFilterChange: (next) => (state.skillsFilter = next),
    onSkillsRefresh: () => {
      if (resolvedAgentId) {
        void loadAgentSkills(state, resolvedAgentId);
      }
    },
    onAgentSkillToggle: (agentId, skillName, enabled) => {
      const index = ensureAgentIndex(agentId);
      if (index < 0) {
        return;
      }
      const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)?.agents
        ?.list;
      const entry = Array.isArray(list) ? (list[index] as { skills?: unknown }) : undefined;
      const normalizedSkill = skillName.trim();
      if (!normalizedSkill) {
        return;
      }
      const allSkills =
        state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ?? [];
      const existing = Array.isArray(entry?.skills)
        ? entry.skills.map((name) => String(name).trim()).filter(Boolean)
        : undefined;
      const base = existing ?? allSkills;
      const next = new Set(base);
      if (enabled) {
        next.add(normalizedSkill);
      } else {
        next.delete(normalizedSkill);
      }
      updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
    },
    onAgentSkillsClear: (agentId) => {
      const index = findAgentIndex(agentId);
      if (index < 0) {
        return;
      }
      removeConfigFormValue(state, ["agents", "list", index, "skills"]);
    },
    onAgentSkillsDisableAll: (agentId) => {
      const index = ensureAgentIndex(agentId);
      if (index < 0) {
        return;
      }
      updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
    },
    onModelChange: (agentId, modelId) => {
      const index = modelId ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
      if (index < 0) {
        return;
      }
      const modelEntry = resolveAgentModelFormEntry(index);
      const { basePath, existing } = modelEntry;
      if (!modelId) {
        removeConfigFormValue(state, basePath);
      } else {
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          const fallbacks = (existing as { fallbacks?: unknown }).fallbacks;
          const next = {
            primary: modelId,
            ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
          };
          updateConfigFormValue(state, basePath, next);
        } else {
          updateConfigFormValue(state, basePath, modelId);
        }
      }
      void refreshVisibleToolsEffectiveForCurrentSession(state);
    },
    onModelFallbacksChange: (agentId, fallbacks) => {
      const normalized = fallbacks.map((name) => name.trim()).filter(Boolean);
      const currentConfig = getCurrentConfigValue();
      const resolvedConfig = resolveAgentConfig(currentConfig, agentId);
      const effectivePrimary =
        resolveModelPrimary(resolvedConfig.entry?.model) ??
        resolveModelPrimary(resolvedConfig.defaults?.model);
      const effectiveFallbacks = resolveEffectiveModelFallbacks(
        resolvedConfig.entry?.model,
        resolvedConfig.defaults?.model,
      );
      const index =
        normalized.length > 0
          ? effectivePrimary
            ? ensureAgentIndex(agentId)
            : -1
          : (effectiveFallbacks?.length ?? 0) > 0 || findAgentIndex(agentId) >= 0
            ? ensureAgentIndex(agentId)
            : -1;
      if (index < 0) {
        return;
      }
      const { basePath, existing } = resolveAgentModelFormEntry(index);
      const resolvePrimary = () => {
        if (typeof existing === "string") {
          return existing.trim() || null;
        }
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          const primary = (existing as { primary?: unknown }).primary;
          if (typeof primary === "string") {
            const trimmed = primary.trim();
            return trimmed || null;
          }
        }
        return null;
      };
      const primary = resolvePrimary() ?? effectivePrimary;
      if (normalized.length === 0) {
        if (primary) {
          updateConfigFormValue(state, basePath, primary);
        } else {
          removeConfigFormValue(state, basePath);
        }
        return;
      }
      if (!primary) {
        return;
      }
      updateConfigFormValue(state, basePath, { primary, fallbacks: normalized });
    },
    onSetDefault: (agentId) => {
      stageDefaultAgentConfigEntry(state, agentId);
    },
  });
}
