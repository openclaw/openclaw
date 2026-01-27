import { html, nothing } from "lit";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { AppViewState } from "./app-view-state";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import {
  TAB_GROUPS,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation";
import { icon, icons } from "./icons";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatQueueItem, CronFormState } from "./ui-types";
import { refreshChatAvatar } from "./app-chat";
import { renderChat } from "./views/chat";
import { renderConfig } from "./views/config";
import { renderChannels } from "./views/channels";
import { renderCron } from "./views/cron";
import { renderDebug } from "./views/debug";
import { renderInstances } from "./views/instances";
import { renderLogs } from "./views/logs";
import { renderNodes } from "./views/nodes";
import { renderOverview } from "./views/overview";
import { renderOverseer } from "./views/overseer";
import { renderAgents } from "./views/agents";
import { renderSessions } from "./views/sessions";
import { renderExecApprovalPrompt } from "./views/exec-approval";
import {
  renderCommandPalette,
  createDefaultCommands,
  createContextCommands,
  type Command,
} from "./components/command-palette";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices";
import { renderSkills } from "./views/skills";
import { renderLanding } from "./views/landing";
import { renderChatControls, renderTab, renderThemeToggle } from "./app-render.helpers";
import { loadChannels } from "./controllers/channels";
import { loadPresence } from "./controllers/presence";
import {
  agentSessionKey,
  deleteSessionsBulk,
  deleteSession,
  findSessionForAgent,
  loadSessions,
  patchSession,
} from "./controllers/sessions";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillMessage,
} from "./controllers/skills";
import { loadNodes } from "./controllers/nodes";
import { loadChatHistory } from "./controllers/chat";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals";
import { loadCronRuns, toggleCronJob, runCronJob, removeCronJob, addCronJob } from "./controllers/cron";
import { loadDebug, callDebugMethod } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { toggleKeyboardShortcutsModal } from "./components/keyboard-shortcuts-modal";
import { toast } from "./components/toast";

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId =
    parsed?.agentId ??
    state.agentsList?.defaultId ??
    "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) return undefined;
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) return candidate;
  return identity?.avatarUrl;
}

function applySessionSelection(state: AppViewState, sessionKey: string) {
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.chatQueue = [];
  state.resetToolStream();
  state.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
  void state.loadAssistantIdentity();
}

async function resolveAgentSessionKey(
  state: AppViewState,
  agentId: string,
): Promise<string> {
  const trimmed = agentId.trim();
  const localMatch = findSessionForAgent(state.sessionsResult, trimmed);
  if (localMatch) return localMatch;

  if (state.client && state.connected) {
    try {
      const res = (await state.client.request("sessions.list", {
        agentId: trimmed,
        limit: 1,
        includeGlobal: false,
        includeUnknown: false,
      })) as SessionsListResult | undefined;
      const key = res?.sessions?.[0]?.key;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // Fall through to starting a new session.
    }
  }

  const mainKey = state.agentsList?.mainKey;
  const fallbackKey = agentSessionKey(trimmed, mainKey);
  if (state.client && state.connected) {
    try {
      await state.client.request("sessions.reset", { key: fallbackKey });
    } catch {
      // Ignore reset failures; the session might still be usable.
    }
  }
  return fallbackKey;
}

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  const isLanding = state.tab === "landing";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;

  // Landing page bypasses the standard shell layout
  if (isLanding) {
    return renderLanding({
      onGetStarted: () => state.setTab("chat"),
      onBookDemo: () => {
        // Could open external link or modal
        window.open("https://docs.clawd.bot", "_blank");
      },
    });
  }

  return html`
    <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle"
            @click=${() =>
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">${icon(state.settings.navCollapsed ? "panel-left" : "menu", { size: 18 })}</span>
          </button>
          <div class="brand">
            <div class="brand-logo">
              <img src="https://mintcdn.com/clawdhub/4rYvG-uuZrMK_URE/assets/pixel-lobster.svg?fit=max&auto=format&n=4rYvG-uuZrMK_URE&q=85&s=da2032e9eac3b5d9bfe7eb96ca6a8a26" alt="Clawdbot" />
            </div>
            <div class="brand-text">
              <div class="brand-title">CLAWDBOT</div>
              <div class="brand-sub">Gateway Dashboard</div>
            </div>
          </div>
        </div>
        <div class="topbar-status">
          <div class="pill">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
          ${renderThemeToggle(state)}
        </div>
      </header>
      <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">
        ${TAB_GROUPS.map((group) => {
          const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
          const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
          return html`
            <div class="nav-group ${isGroupCollapsed && !hasActiveTab ? "nav-group--collapsed" : ""}">
              <button
                class="nav-label"
                @click=${() => {
                  const next = { ...state.settings.navGroupsCollapsed };
                  next[group.label] = !isGroupCollapsed;
                  state.applySettings({
                    ...state.settings,
                    navGroupsCollapsed: next,
                  });
                }}
                aria-expanded=${!isGroupCollapsed}
              >
                <span class="nav-label__text">${group.label}</span>
                <span class="nav-label__chevron">${icon("chevron-down", { size: 14 })}</span>
              </button>
              <div class="nav-group__items">
                ${group.tabs.map((tab) => renderTab(state, tab))}
              </div>
            </div>
          `;
        })}
        <div class="nav-group nav-group--links">
          <div class="nav-label nav-label--static">
            <span class="nav-label__text">Resources</span>
          </div>
          <div class="nav-group__items">
            <a
              class="nav-item nav-item--external"
              href="https://docs.clawd.bot"
              target="_blank"
              rel="noreferrer"
              title="Docs (opens in new tab)"
            >
              <span class="nav-item__icon" aria-hidden="true">${icon("book-open", { size: 18 })}</span>
              <span class="nav-item__text">Docs</span>
            </a>
          </div>
        </div>
      </aside>
      <main
        class="content ${isChat ? "content--chat" : ""} ${state.tab === "sessions" && state.sessionsViewMode === "table" ? "content--sessions-table" : ""}"
      >
        <section class="content-header">
          <div>
            <div class="page-title">${titleForTab(state.tab)}</div>
            <div class="page-sub">${subtitleForTab(state.tab)}</div>
          </div>
          <div class="page-meta">
            ${state.lastError
              ? html`<div class="pill danger">${state.lastError}</div>`
              : nothing}
            ${isChat ? renderChatControls(state) : nothing}
          </div>
        </section>

        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastChannelsRefresh: state.channelsLastSuccess,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.chatMessage = "";
                state.resetToolStream();
                state.applySettings({
                  ...state.settings,
                  sessionKey: next,
                  lastActiveSessionKey: next,
                });
                void state.loadAssistantIdentity();
              },
              onConnect: () => state.connect(),
              onRefresh: () => state.loadOverview(),
            })
          : nothing}

        ${state.tab === "channels"
          ? renderChannels({
              connected: state.connected,
              loading: state.channelsLoading,
              snapshot: state.channelsSnapshot,
              lastError: state.channelsError,
              lastSuccessAt: state.channelsLastSuccess,
              whatsappMessage: state.whatsappLoginMessage,
              whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
              whatsappConnected: state.whatsappLoginConnected,
              whatsappBusy: state.whatsappBusy,
              configSchema: state.configSchema,
              configSchemaLoading: state.configSchemaLoading,
              configForm: state.configForm,
              configUiHints: state.configUiHints,
              configSaving: state.configSaving,
              configFormDirty: state.configFormDirty,
              nostrProfileFormState: state.nostrProfileFormState,
              nostrProfileAccountId: state.nostrProfileAccountId,
              onRefresh: (probe) => loadChannels(state, probe),
              onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
              onWhatsAppWait: () => state.handleWhatsAppWait(),
              onWhatsAppLogout: () => state.handleWhatsAppLogout(),
              onConfigPatch: (path, value) => {
                updateConfigFormValue(state, path, value);
                // Mark wizard as dirty when editing through the wizard
                if (state.channelWizardState.open) {
                  state.channelWizardState = {
                    ...state.channelWizardState,
                    isDirty: true,
                  };
                }
              },
              onConfigSave: () => state.handleChannelConfigSave(),
              onConfigReload: () => state.handleChannelConfigReload(),
              onNostrProfileEdit: (accountId, profile) =>
                state.handleNostrProfileEdit(accountId, profile),
              onNostrProfileCancel: () => state.handleNostrProfileCancel(),
              onNostrProfileFieldChange: (field, value) =>
                state.handleNostrProfileFieldChange(field, value),
              onNostrProfileSave: () => state.handleNostrProfileSave(),
              onNostrProfileImport: () => state.handleNostrProfileImport(),
              onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
              // Channel wizard props
              wizardState: state.channelWizardState,
              onWizardOpen: (channelId) => state.handleChannelWizardOpen(channelId),
              onWizardClose: () => state.handleChannelWizardClose(),
              onWizardSave: () => state.handleChannelWizardSave(),
              onWizardDiscard: () => state.handleChannelWizardDiscard(),
              onWizardSectionChange: (sectionId) => state.handleChannelWizardSectionChange(sectionId),
              onWizardConfirmClose: () => state.handleChannelWizardConfirmClose(),
              onWizardCancelClose: () => state.handleChannelWizardCancelClose(),
            })
          : nothing}

        ${state.tab === "instances"
          ? renderInstances({
              loading: state.presenceLoading,
              entries: state.presenceEntries,
              lastError: state.presenceError,
              statusMessage: state.presenceStatus,
              onRefresh: () => loadPresence(state),
            })
          : nothing}

        ${state.tab === "agents"
          ? renderAgents({
              loading: state.agentsLoading || state.sessionsLoading,
              agents: state.agentsList,
              sessions: state.sessionsResult,
              error: state.agentsError ?? state.sessionsError,
              selectedAgentKey: state.agentsUiSelectedAgentKey,
              agentSearch: state.agentsUiAgentSearch,
              sessionSearch: state.agentsUiSessionSearch,
              sessionTypeFilter: state.agentsUiSessionTypeFilter,
              onSelectAgent: (agentId) => {
                state.agentsUiSelectedAgentKey = agentId;
              },
              onAgentSearchChange: (search) => {
                state.agentsUiAgentSearch = search;
              },
              onSessionSearchChange: (search) => {
                state.agentsUiSessionSearch = search;
              },
              onSessionTypeFilterChange: (next) => {
                state.agentsUiSessionTypeFilter = next;
              },
              onSessionOpenChat: (sessionKey) => {
                applySessionSelection(state, sessionKey);
                state.setTab("chat");
              },
              onAgentOpenChat: async (agentId) => {
                const sessionKey = await resolveAgentSessionKey(state, agentId);
                applySessionSelection(state, sessionKey);
                state.setTab("chat");
              },
              onRefresh: () => {
                void loadAgents(state);
                void loadSessions(state);
              },
            })
          : nothing}

        ${state.tab === "sessions"
          ? renderSessions({
              loading: state.sessionsLoading,
              result: state.sessionsResult,
              error: state.sessionsError,
              activeTasks: state.sessionsActiveTasksByKey,
              activeMinutes: state.sessionsFilterActive,
              limit: state.sessionsFilterLimit,
              includeGlobal: state.sessionsIncludeGlobal,
              includeUnknown: state.sessionsIncludeUnknown,
              basePath: state.basePath,
              search: state.sessionsSearch,
              sort: state.sessionsSort,
              sortDir: state.sessionsSortDir,
              kindFilter: state.sessionsKindFilter,
	              statusFilter: state.sessionsStatusFilter,
	              agentLabelFilter: state.sessionsAgentLabelFilter,
		              laneFilter: state.sessionsLaneFilter,
		              tagFilter: state.sessionsTagFilter,
		              viewMode: state.sessionsViewMode,
		              showHidden: state.sessionsShowHidden,
		              autoHideCompletedMinutes: state.sessionsAutoHideCompletedMinutes,
		              autoHideErroredMinutes: state.sessionsAutoHideErroredMinutes,
		              drawerKey: state.sessionsDrawerKey,
		              drawerExpanded: state.sessionsDrawerExpanded,
		              drawerPreviewLoading: state.sessionsPreviewLoading,
		              drawerPreviewError: state.sessionsPreviewError,
		              drawerPreview: state.sessionsPreviewEntry,
              onDrawerOpen: (sessionKey) => state.handleSessionsDrawerOpen(sessionKey),
              onDrawerOpenExpanded: (sessionKey) => state.handleSessionsDrawerOpenExpanded(sessionKey),
              onDrawerClose: () => state.handleSessionsDrawerClose(),
              onDrawerToggleExpanded: () => state.handleSessionsDrawerToggleExpanded(),
              onDrawerRefreshPreview: () => state.handleSessionsDrawerRefreshPreview(),
              onSessionOpen: (sessionKey) => {
                applySessionSelection(state, sessionKey);
                state.setTab("chat");
              },
              onFiltersChange: (next) => {
                state.sessionsFilterActive = next.activeMinutes;
                state.sessionsFilterLimit = next.limit;
                state.sessionsIncludeGlobal = next.includeGlobal;
                state.sessionsIncludeUnknown = next.includeUnknown;
              },
              onSearchChange: (search) => {
                state.sessionsSearch = search;
              },
              onSortChange: (column) => {
                if (state.sessionsSort === column) {
                  state.sessionsSortDir = state.sessionsSortDir === "asc" ? "desc" : "asc";
                } else {
                  state.sessionsSort = column;
                  state.sessionsSortDir = column === "updated" ? "desc" : "asc";
                }
              },
              onKindFilterChange: (kind) => {
                state.sessionsKindFilter = kind;
              },
              onStatusFilterChange: (status) => {
                state.sessionsStatusFilter = status;
              },
              onAgentLabelFilterChange: (label) => {
                state.sessionsAgentLabelFilter = label;
              },
	              onTagFilterChange: (tags) => {
	                state.sessionsTagFilter = tags;
	              },
	              onLaneFilterChange: (lane) => {
	                state.sessionsLaneFilter = lane;
	              },
		              onViewModeChange: (mode) => {
		                state.sessionsViewMode = mode;
		                try {
		                  window.localStorage.setItem(
		                    "clawdbot.control.ui.sessions.viewMode.v1",
		                    mode,
		                  );
		                } catch {
		                  // Ignore storage errors
		                }
		              },
		              onShowHiddenChange: (next) => {
		                state.sessionsShowHidden = next;
		                try {
		                  window.localStorage.setItem(
		                    "clawdbot.control.ui.sessions.showHidden.v1",
		                    next ? "true" : "false",
		                  );
		                } catch {
		                  // Ignore storage errors
		                }
		              },
		              onAutoHideChange: (next) => {
		                state.sessionsAutoHideCompletedMinutes = next.completedMinutes;
		                state.sessionsAutoHideErroredMinutes = next.erroredMinutes;
		                try {
		                  window.localStorage.setItem(
		                    "clawdbot.control.ui.sessions.autoHide.completedMinutes.v1",
		                    String(next.completedMinutes),
		                  );
		                  window.localStorage.setItem(
		                    "clawdbot.control.ui.sessions.autoHide.erroredMinutes.v1",
		                    String(next.erroredMinutes),
		                  );
		                } catch {
		                  // Ignore storage errors
		                }
		              },
		              onDeleteMany: async (keys) => {
		                await deleteSessionsBulk(state, keys);
		              },
		              onRefresh: () => loadSessions(state),
		              onPatch: (key, patch) => patchSession(state, key, patch),
		              onDelete: (key) => deleteSession(state, key),
		            })
		          : nothing}

        ${state.tab === "cron"
          ? renderCron({
              loading: state.cronLoading,
              status: state.cronStatus,
              jobs: state.cronJobs,
              error: state.cronError,
              busy: state.cronBusy,
              form: state.cronForm,
              channels: state.channelsSnapshot?.channelMeta?.length
                ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                : state.channelsSnapshot?.channelOrder ?? [],
              channelLabels: state.channelsSnapshot?.channelLabels ?? {},
              channelMeta: state.channelsSnapshot?.channelMeta ?? [],
              runsJobId: state.cronRunsJobId,
              runs: state.cronRuns,
              onFormChange: (patch) => (state.cronForm = { ...state.cronForm, ...patch }),
              onRefresh: () => state.loadCron(),
              onAdd: () => addCronJob(state),
              onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
              onRun: (job) => runCronJob(state, job),
              onRemove: (job) => removeCronJob(state, job),
              onLoadRuns: (jobId) => loadCronRuns(state, jobId),
            })
          : nothing}

        ${state.tab === "skills"
          ? renderSkills({
              loading: state.skillsLoading,
              report: state.skillsReport,
              error: state.skillsError,
              filter: state.skillsFilter,
              edits: state.skillEdits,
              messages: state.skillMessages,
              busyKey: state.skillsBusyKey,
              onFilterChange: (next) => (state.skillsFilter = next),
              onRefresh: () => loadSkills(state, { clearMessages: true }),
              onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
              onEdit: (key, value) => updateSkillEdit(state, key, value),
              onSaveKey: (key) => saveSkillApiKey(state, key),
              onInstall: (skillKey, name, installId) =>
                installSkill(state, skillKey, name, installId),
            })
          : nothing}

        ${state.tab === "overseer"
          ? renderOverseer({
              loading: state.overseerLoading,
              error: state.overseerError,
              status: state.overseerStatus,
              goalLoading: state.overseerGoalLoading,
              goalError: state.overseerGoalError,
              goal: state.overseerGoal,
              selectedGoalId: state.overseerSelectedGoalId,
              showOverseerGraph: state.showOverseerGraph,
              showSystemGraph: state.showSystemGraph,
              overseerViewport: state.overseerViewport,
              overseerDrag: state.overseerDrag,
              systemViewport: state.systemViewport,
              systemDrag: state.systemDrag,
              selectedOverseerNodeId: state.overseerSelectedNodeId,
              selectedSystemNodeId: state.systemSelectedNodeId,
              drawerOpen: state.overseerDrawerOpen,
              drawerKind: state.overseerDrawerKind,
              drawerNodeId: state.overseerDrawerNodeId,
              nodes: state.nodes,
              presenceEntries: state.presenceEntries,
              cronJobs: state.cronJobs,
              cronRunsJobId: state.cronRunsJobId,
              cronRuns: state.cronRuns,
              skillsReport: state.skillsReport,
              agents: state.agentsList,
              sessions: state.sessionsResult,
              channels: state.channelsSnapshot,
              // Goal management state
              goalActionPending: state.overseerGoalActionPending,
              goalActionError: state.overseerGoalActionError,
              createGoalOpen: state.overseerCreateGoalOpen,
              createGoalForm: state.overseerCreateGoalForm,
              activityFilterStatus: state.overseerActivityFilterStatus,
              activityLimit: state.overseerActivityLimit,
              connected: state.connected,
              // Simulator state
              simulatorState: state.simulator,
              simulatorProps: {
                onTogglePanel: () => {},
                onSectionChange: () => {},
                onModeChange: () => {},
                onAddRule: () => {},
                onAddRuleFromTemplate: () => {},
                onUpdateRule: () => {},
                onDeleteRule: () => {},
                onToggleRuleEnabled: () => {},
                onSelectRule: () => {},
                onCloseRuleEditor: () => {},
                onSaveDraftRule: () => {},
                onAddCondition: () => {},
                onUpdateCondition: () => {},
                onDeleteCondition: () => {},
                onAddAction: () => {},
                onUpdateAction: () => {},
                onDeleteAction: () => {},
                onUpdateFilters: () => {},
                onClearFilters: () => {},
                onQueueEvent: () => {},
                onRemoveQueuedEvent: () => {},
                onClearEventQueue: () => {},
                onExecuteEvent: () => {},
                onAddScenario: () => {},
                onAddScenarioFromTemplate: () => {},
                onUpdateScenario: () => {},
                onDeleteScenario: () => {},
                onSelectScenario: () => {},
                onCloseScenarioEditor: () => {},
                onSaveDraftScenario: () => {},
                onStartRun: () => {},
                onPauseRun: () => {},
                onResumeRun: () => {},
                onStopRun: () => {},
                onResetSimulator: () => {},
                onClearActivityLog: () => {},
                onUpdateSettings: () => {},
                onSaveState: () => {},
                onLoadState: () => {},
              },
              onRefresh: () => state.handleOverseerRefresh(),
              onTick: () => state.handleOverseerTick(),
              onSelectGoal: (goalId) => state.handleOverseerSelectGoal(goalId),
              onToggleOverseerGraph: (next) =>
                state.handleOverseerToggleGraph("overseer", next),
              onToggleSystemGraph: (next) =>
                state.handleOverseerToggleGraph("system", next),
              onSelectOverseerNode: (nodeId) => state.handleOverseerSelectOverseerNode(nodeId),
              onSelectSystemNode: (nodeId) => state.handleOverseerSelectSystemNode(nodeId),
              onViewportChange: (kind, next) =>
                state.handleOverseerViewportChange(kind, next),
              onDragChange: (kind, next) => state.handleOverseerDragChange(kind, next),
              onDrawerClose: () => state.handleOverseerDrawerClose(),
              onLoadCronRuns: (jobId) => state.handleOverseerLoadCronRuns(jobId),
              // Goal management handlers
              onPauseGoal: (goalId) => state.handleOverseerPauseGoal(goalId),
              onResumeGoal: (goalId) => state.handleOverseerResumeGoal(goalId),
              onOpenCreateGoal: () => state.handleOverseerOpenCreateGoal(),
              onCloseCreateGoal: () => state.handleOverseerCloseCreateGoal(),
              onCreateGoal: (params) => state.handleOverseerCreateGoal(params),
              onUpdateCreateGoalForm: (updates) => state.handleOverseerUpdateCreateGoalForm(updates),
              onMarkWorkDone: (goalId, workNodeId, summary) =>
                state.handleOverseerMarkWorkDone(goalId, workNodeId, summary),
              onBlockWork: (goalId, workNodeId, reason) =>
                state.handleOverseerBlockWork(goalId, workNodeId, reason),
              onRetryAssignment: (goalId, workNodeId) =>
                state.handleOverseerRetryAssignment(goalId, workNodeId),
              onActivityFilterChange: (status) => state.handleOverseerActivityFilterChange(status),
              onActivityLimitChange: (limit) => state.handleOverseerActivityLimitChange(limit),
            })
          : nothing}

        ${state.tab === "nodes"
          ? renderNodes({
              loading: state.nodesLoading,
              nodes: state.nodes,
              devicesLoading: state.devicesLoading,
              devicesError: state.devicesError,
              devicesList: state.devicesList,
              configForm: state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null),
              configLoading: state.configLoading,
              configSaving: state.configSaving,
              configDirty: state.configFormDirty,
              configFormMode: state.configFormMode,
              execApprovalsLoading: state.execApprovalsLoading,
              execApprovalsSaving: state.execApprovalsSaving,
              execApprovalsDirty: state.execApprovalsDirty,
              execApprovalsSnapshot: state.execApprovalsSnapshot,
              execApprovalsForm: state.execApprovalsForm,
              execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
              execApprovalsTarget: state.execApprovalsTarget,
              execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
              onRefresh: () => loadNodes(state),
              onDevicesRefresh: () => loadDevices(state),
              onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
              onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
              onDeviceRotate: (deviceId, role, scopes) =>
                rotateDeviceToken(state, { deviceId, role, scopes }),
              onDeviceRevoke: (deviceId, role) =>
                revokeDeviceToken(state, { deviceId, role }),
              onLoadConfig: () => loadConfig(state),
              onLoadExecApprovals: () => {
                const target =
                  state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                    ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                    : { kind: "gateway" as const };
                return loadExecApprovals(state, target);
              },
              onBindDefault: (nodeId) => {
                if (nodeId) {
                  updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                } else {
                  removeConfigFormValue(state, ["tools", "exec", "node"]);
                }
              },
              onBindAgent: (agentIndex, nodeId) => {
                const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
                if (nodeId) {
                  updateConfigFormValue(state, basePath, nodeId);
                } else {
                  removeConfigFormValue(state, basePath);
                }
              },
              onSaveBindings: () => saveConfig(state),
              onExecApprovalsTargetChange: (kind, nodeId) => {
                state.execApprovalsTarget = kind;
                state.execApprovalsTargetNodeId = nodeId;
                state.execApprovalsSnapshot = null;
                state.execApprovalsForm = null;
                state.execApprovalsDirty = false;
                state.execApprovalsSelectedAgent = null;
              },
              onExecApprovalsSelectAgent: (agentId) => {
                state.execApprovalsSelectedAgent = agentId;
              },
              onExecApprovalsPatch: (path, value) =>
                updateExecApprovalsFormValue(state, path, value),
              onExecApprovalsRemove: (path) =>
                removeExecApprovalsFormValue(state, path),
              onSaveExecApprovals: () => {
                const target =
                  state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                    ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                    : { kind: "gateway" as const };
                return saveExecApprovals(state, target);
              },
            })
          : nothing}

        ${state.tab === "chat"
          ? renderChat({
              sessionKey: state.sessionKey,
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.chatMessage = "";
                state.chatAttachments = [];
                state.chatStream = null;
                state.chatStreamStartedAt = null;
                state.chatRunId = null;
                state.chatQueue = [];
                state.resetToolStream();
                state.resetChatScroll();
                state.applySettings({
                  ...state.settings,
                  sessionKey: next,
                  lastActiveSessionKey: next,
                });
                void state.loadAssistantIdentity();
                void loadChatHistory(state);
                void refreshChatAvatar(state);
              },
              thinkingLevel: state.chatThinkingLevel,
              showThinking,
              loading: state.chatLoading,
              sending: state.chatSending,
              compactionStatus: state.compactionStatus,
              assistantAvatarUrl: chatAvatarUrl,
              messages: state.chatMessages,
              toolMessages: state.chatToolMessages,
              stream: state.chatStream,
              streamStartedAt: state.chatStreamStartedAt,
              draft: state.chatMessage,
              queue: state.chatQueue,
              connected: state.connected,
              canSend: state.connected,
              audioInputSupported: state.audioInputSupported,
              audioRecording: state.audioRecording,
              audioInputError: state.audioInputError,
              readAloudSupported: state.readAloudSupported,
              readAloudActive: state.readAloudActive,
              readAloudError: state.readAloudError,
              ttsLoading: state.ttsLoading,
              ttsError: state.ttsError,
              ttsProviders: state.ttsProviders,
              ttsActiveProvider: state.ttsActiveProvider,
              disabledReason: chatDisabledReason,
              error: state.lastError,
              sessions: state.sessionsResult,
              focusMode: chatFocus,
              onRefresh: () => {
                state.resetToolStream();
                return Promise.all([loadChatHistory(state), refreshChatAvatar(state)]);
              },
              onToggleFocusMode: () => {
                if (state.onboarding) return;
                state.applySettings({
                  ...state.settings,
                  chatFocusMode: !state.settings.chatFocusMode,
                });
              },
              onChatScroll: (event) => state.handleChatScroll(event),
              onDraftChange: (next) => (state.chatMessage = next),
              attachments: state.chatAttachments,
              onAttachmentsChange: (next) => (state.chatAttachments = next),
              onSend: () => state.handleSendChat(),
              canAbort: Boolean(state.chatRunId),
              onAbort: () => void state.handleAbortChat(),
              onToggleAudioRecording: () => state.handleToggleAudioRecording(),
              onReadAloud: (text) => state.handleReadAloudToggle(text),
              onTtsProviderChange: (provider) => state.handleTtsProviderChange(provider),
              onQueueRemove: (id) => state.removeQueuedMessage(id),
              onNewSession: () =>
                state.handleSendChat("/new", { restoreDraft: true }),
              // Sidebar props for tool output viewing
              sidebarOpen: state.sidebarOpen,
              sidebarContent: state.sidebarContent,
              sidebarError: state.sidebarError,
              splitRatio: state.splitRatio,
              onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
              onCloseSidebar: () => state.handleCloseSidebar(),
              onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
              assistantName: state.assistantName,
              assistantAvatar: state.assistantAvatar,
              // Task sidebar props
              taskSidebarOpen: state.taskSidebarOpen,
              tasks: state.chatTasks,
              activityLog: state.chatActivityLog,
              expandedTaskIds: state.taskSidebarExpandedIds,
              taskCount: state.chatTasks.length,
              onOpenTaskSidebar: () => state.handleOpenTaskSidebar(),
              onCloseTaskSidebar: () => state.handleCloseTaskSidebar(),
              onToggleTaskExpanded: (taskId: string) => state.handleToggleTaskExpanded(taskId),
            })
          : nothing}

        ${state.tab === "config"
          ? renderConfig({
              raw: state.configRaw,
              originalRaw: state.configRawOriginal,
              valid: state.configValid,
              issues: state.configIssues,
              loading: state.configLoading,
              saving: state.configSaving,
              applying: state.configApplying,
              updating: state.updateRunning,
              connected: state.connected,
              schema: state.configSchema,
              schemaLoading: state.configSchemaLoading,
              uiHints: state.configUiHints,
              formMode: state.configFormMode,
              formValue: state.configForm,
              originalValue: state.configFormOriginal,
              searchQuery: state.configSearchQuery,
              activeSection: state.configActiveSection,
              activeSubsection: state.configActiveSubsection,
              onRawChange: (next) => {
                state.configRaw = next;
              },
              onFormModeChange: (mode) => (state.configFormMode = mode),
              onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
              onSearchChange: (query) => (state.configSearchQuery = query),
              onSectionChange: (section) => {
                state.configActiveSection = section;
                state.configActiveSubsection = null;
              },
              onSubsectionChange: (section) => (state.configActiveSubsection = section),
              onReload: () => loadConfig(state),
              onSave: () => saveConfig(state),
              onApply: () => applyConfig(state),
              onUpdate: () => runUpdate(state),
            })
          : nothing}

        ${state.tab === "debug"
          ? renderDebug({
              loading: state.debugLoading,
              status: state.debugStatus,
              health: state.debugHealth,
              models: state.debugModels,
              heartbeat: state.debugHeartbeat,
              eventLog: state.eventLog,
              callMethod: state.debugCallMethod,
              callParams: state.debugCallParams,
              callResult: state.debugCallResult,
              callError: state.debugCallError,
              onCallMethodChange: (next) => (state.debugCallMethod = next),
              onCallParamsChange: (next) => (state.debugCallParams = next),
              onRefresh: () => loadDebug(state),
              onCall: () => callDebugMethod(state),
            })
          : nothing}

        ${state.tab === "logs"
          ? renderLogs({
              loading: state.logsLoading,
              error: state.logsError,
              file: state.logsFile,
              entries: state.logsEntries,
              filterText: state.logsFilterText,
              levelFilters: state.logsLevelFilters,
              autoFollow: state.logsAutoFollow,
              truncated: state.logsTruncated,
              showRelativeTime: state.logsShowRelativeTime,
              showSidebar: state.logsShowSidebar,
              showFilters: state.logsShowFilters,
              subsystemFilters: state.logsSubsystemFilters,
              availableSubsystems: [
                ...new Set(state.logsEntries.map((e) => e.subsystem).filter(Boolean) as string[]),
              ].sort(),
              onFilterTextChange: (next) => (state.logsFilterText = next),
              onLevelToggle: (level, enabled) => {
                state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
              },
              onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
              onToggleRelativeTime: (next) => (state.logsShowRelativeTime = next),
              onRefresh: () => loadLogs(state, { reset: true }),
              onClear: () => state.clearLogs(),
              onExport: (lines, label) => state.exportLogs(lines, label),
              onScroll: (event) => state.handleLogsScroll(event),
              onJumpToBottom: () => state.jumpToLogsBottom(),
              onToggleSidebar: () => state.handleLogsToggleSidebar(),
              onToggleFilters: () => state.handleLogsToggleFilters(),
              onSubsystemToggle: (subsystem) => state.handleLogsSubsystemToggle(subsystem),
            })
          : nothing}
      </main>
      ${renderExecApprovalPrompt(state)}
      ${renderCommandPalette({
        state: {
          open: state.commandPaletteOpen,
          query: state.commandPaletteQuery,
          selectedIndex: state.commandPaletteSelectedIndex,
          activeCategory: state.commandPaletteCategory,
        },
        commands: [
          ...createContextCommands(state.tab, {
            newSession: () => state.handleSendChat("/new", { restoreDraft: true }),
            clearChat: () => state.handleSendChat("/new", { restoreDraft: false }),
            abortChat: state.chatStream ? () => state.handleAbortChat() : undefined,
            refreshSessions: () => loadSessions(state),
            refreshChannels: () => state.loadOverview(),
            refreshCron: () => state.loadCron(),
            createGoal: () => state.handleOverseerOpenCreateGoal(),
            refreshOverseer: () => state.loadOverview(),
            refreshNodes: () => state.loadOverview(),
            refreshSkills: () => loadSkills(state, { clearMessages: true }),
            refreshDebug: () => loadDebug(state),
            refreshInstances: () => loadPresence(state),
            refreshOverview: () => state.loadOverview(),
            refreshLogs: () => loadLogs(state, { reset: true }),
            clearLogs: () => state.clearLogs(),
            exportLogs: state.logsEntries.length > 0 ? () => state.exportLogs(state.logsEntries.map((e) => e.raw), "all") : undefined,
            toggleAutoFollow: () => { state.logsAutoFollow = !state.logsAutoFollow; },
            jumpToLogsBottom: () => state.jumpToLogsBottom(),
          }),
          ...createDefaultCommands(
            (tab) => state.setTab(tab),
            () => state.loadOverview(),
            () => state.handleSendChat("/new", { restoreDraft: true }),
            () => {
              const nextTheme = state.theme === "dark" ? "light" : state.theme === "light" ? "system" : "dark";
              state.setTheme(nextTheme);
            },
            {
              openKeyboardShortcuts: () => toggleKeyboardShortcutsModal(),
              openDocumentation: () => window.open("https://docs.clawd.bot", "_blank"),
              copyGatewayUrl: () => {
                const url = state.basePath || window.location.origin;
                navigator.clipboard.writeText(url).then(() => toast.success("Gateway URL copied"));
              },
            }
          ),
        ],
        onClose: () => state.closeCommandPalette(),
        onQueryChange: (query) => state.setCommandPaletteQuery(query),
        onIndexChange: (index) => state.setCommandPaletteSelectedIndex(index),
        onCategoryChange: (category) => state.setCommandPaletteCategory(category),
        onSelect: (command: Command) => {
          command.action();
          state.closeCommandPalette();
        },
        onFavoritesChange: () => state.bumpCommandPaletteFavVersion(),
      })}
    </div>
  `;
}
