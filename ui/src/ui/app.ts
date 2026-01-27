import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import { showDangerConfirmDialog } from "./components/confirm-dialog";
import { toast } from "./components/toast";
import { resolveInjectedAssistantIdentity } from "./assistant-identity";
import { loadSettings, type UiSettings } from "./storage";
import { renderApp } from "./app-render";
import type { Tab } from "./navigation";
import type { ResolvedTheme, ThemeMode } from "./theme";
import type {
  AgentsListResult,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SessionsPreviewEntry,
  SessionsPreviewResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
} from "./types";
import type {
  OverseerGoalStatusResult,
  OverseerStatusResult,
} from "../../../src/gateway/protocol/schema/overseer.js";
import { type ChatAttachment, type ChatQueueItem, type CronFormState, type GraphDragState, type GraphViewport } from "./ui-types";
import type { EventLogEntry } from "./app-events";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "./controllers/exec-approvals";
import type { DevicePairingList } from "./controllers/devices";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { SkillMessage } from "./controllers/skills";
import type { TtsProviderId, TtsProviderInfo } from "./controllers/tts";
import {
  loadTtsProviders as loadTtsProvidersInternal,
  setTtsProvider as setTtsProviderInternal,
} from "./controllers/tts";
import {
  resetToolStream as resetToolStreamInternal,
  type AgentEventPayload,
  type ToolStreamEntry,
} from "./app-tool-stream";
import type { ChatTask, ChatActivityLog } from "./types/task-types";
import { deriveTasksFromToolStream } from "./controllers/chat-tasks";
import type { SessionActiveTask } from "./views/sessions";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  jumpToLogsBottom as jumpToLogsBottomInternal,
  resetChatScroll as resetChatScrollInternal,
} from "./app-scroll";
import { connectGateway as connectGatewayInternal } from "./app-gateway";
import { loadConfig } from "./controllers/config";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle";
import {
  applySettings as applySettingsInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
} from "./app-chat";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form";
import { createSessionNavigatorState, type SessionNavigatorState } from "./components/session-navigator";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity";
import { loadCronRuns } from "./controllers/cron";
import {
  loadOverseerGoal,
  refreshOverseer as refreshOverseerInternal,
  tickOverseer as tickOverseerInternal,
  pauseOverseerGoal as pauseOverseerGoalInternal,
  resumeOverseerGoal as resumeOverseerGoalInternal,
  createOverseerGoal as createOverseerGoalInternal,
  updateOverseerWorkNode as updateOverseerWorkNodeInternal,
  retryOverseerAssignment as retryOverseerAssignmentInternal,
  initOverseerState,
  initializeSimulator,
} from "./controllers/overseer";
import { createInitialSimulatorState, type SimulatorState } from "./types/overseer-simulator";
import { extractText } from "./chat/message-extract";
import { normalizeMessage, normalizeRoleForGrouping } from "./chat/message-normalizer";

declare global {
  interface Window {
    __CLAWDBRAIN_CONTROL_UI_BASE_PATH__?: string;
    __CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD__?: string;
  }
}

type SpeechRecognitionResultLike = {
  isFinal?: boolean;
  0?: { transcript?: string };
};

type SpeechRecognitionEventLike = {
  resultIndex?: number;
  results?: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function resolveSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function resolveSpeechSynthesisSupport(): boolean {
  if (typeof window === "undefined") return false;
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

/**
 * Resolve onboarding mode from URL params.
 * Note: This is legacy behavior; onboarding is now primarily driven by config state.
 * The URL param still works for manual triggering.
 */
function resolveOnboardingModeFromUrl(): boolean {
  if (!window.location.search) return false;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Check if onboarding should be shown based on config state.
 * Onboarding is shown if:
 * 1. URL param is set (legacy), OR
 * 2. Config has incomplete onboarding progress
 */
function resolveOnboardingMode(): boolean {
  // Check URL param first (for manual triggering)
  if (resolveOnboardingModeFromUrl()) {
    return true;
  }
  // Config state will be checked after connection in checkOnboardingStatus()
  return false;
}

/**
 * Check if onboarding is incomplete after config is loaded.
 * This should be called after config.get completes.
 *
 * Supports both legacy wizard (essentials, health-check) and new V2 wizard (quick-start, ready).
 */
function shouldShowOnboarding(configSnapshot: import("../types").ConfigSnapshot | null): boolean {
  if (!configSnapshot?.valid || !configSnapshot.config) {
    return false;
  }

  const config = configSnapshot.config as Record<string, unknown>;
  const wizard = config.wizard as Record<string, unknown> | undefined;

  // Check if there's incomplete onboarding progress
  if (wizard?.onboarding) {
    const onboarding = wizard.onboarding as {
      completedPhases: string[];
      currentPhase: string;
      startedAt: string;
    };

    const completed = onboarding.completedPhases ?? [];

    // Check for new V2 wizard completion (has "ready" phase or at least "quick-start")
    const hasQuickStart = completed.includes("quick-start");
    const hasReady = completed.includes("ready");

    // Check for legacy wizard completion (has "essentials" and "health-check")
    const hasEssentials = completed.includes("essentials");
    const hasHealthCheck = completed.includes("health-check");

    // Onboarding is complete if EITHER:
    // 1. New wizard: Has "quick-start" (can skip to "ready" phase) or "ready"
    // 2. Legacy wizard: Has both "essentials" and "health-check"
    const newWizardComplete = hasQuickStart || hasReady;
    const legacyWizardComplete = hasEssentials && hasHealthCheck;

    return !(newWizardComplete || legacyWizardComplete);
  }

  return false;
}

function resolveDefaultGatewayPassword(): string {
  const injected =
    typeof window !== "undefined"
      ? window.__CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD__
      : undefined;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  const fromEnv =
    typeof import.meta !== "undefined" &&
    typeof import.meta.env?.VITE_CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD === "string"
      ? import.meta.env.VITE_CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD.trim()
      : "";
  return fromEnv;
}

const SESSIONS_VIEW_MODE_STORAGE_KEY = "clawdbrain.control.ui.sessions.viewMode.v1";

function readSessionsViewMode(): "list" | "table" {
  if (typeof window === "undefined") return "list";
  try {
    const raw = window.localStorage.getItem(SESSIONS_VIEW_MODE_STORAGE_KEY);
    return raw === "table" ? "table" : "list";
  } catch {
    return "list";
  }
}

const SESSIONS_SHOW_HIDDEN_STORAGE_KEY = "clawdbrain.control.ui.sessions.showHidden.v1";
const SESSIONS_AUTO_HIDE_COMPLETED_MINUTES_KEY =
  "clawdbrain.control.ui.sessions.autoHide.completedMinutes.v1";
const SESSIONS_AUTO_HIDE_ERRORED_MINUTES_KEY =
  "clawdbrain.control.ui.sessions.autoHide.erroredMinutes.v1";

function readBooleanStorage(key: string, fallback = false): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return raw === "true" || raw === "1" || raw === "yes";
  } catch {
    return fallback;
  }
}

function readNumberStorage(key: string, fallback = 0, min = 0, max = 10_080): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  } catch {
    return fallback;
  }
}

@customElement("clawdbrain-app")
export class ClawdbrainApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = resolveDefaultGatewayPassword();
  @state() overviewShowSystemMetrics = this.settings.overviewShowSystemMetrics;
  @state() tab: Tab = "chat";
  @state() navShowAdvanced = this.settings.navShowAdvanced;
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() compactionStatus: import("./app-tool-stream").CompactionStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() audioInputSupported = false;
  @state() audioRecording = false;
  @state() audioInputError: string | null = null;
  @state() readAloudSupported = false;
  @state() readAloudActive = false;
  @state() readAloudError: string | null = null;
  @state() ttsLoading = false;
  @state() ttsError: string | null = null;
  @state() ttsProviders: TtsProviderInfo[] = [];
  @state() ttsActiveProvider: TtsProviderId | null = null;
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  // Task sidebar state
  @state() taskSidebarOpen = false;
  @state() chatTasks: ChatTask[] = [];
  @state() chatActivityLog: ChatActivityLog[] = [];
  @state() taskSidebarExpandedIds: Set<string> = new Set();
  // Voice dropdown state (compose toolbar)
  @state() voiceDropdownOpen = false;
  private taskSidebarKeyboardCleanup: (() => void) | null = null;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() execApprovalShowAdvanced = false;
  @state() execApprovalHistory: import("./views/exec-approval").ExecApprovalHistoryEntry[] = [];
  @state() execApprovalHistoryOpen = false;
  toggleExecApprovalHistory: (() => void) | null = () => {
    this.execApprovalHistoryOpen = !this.execApprovalHistoryOpen;
  };
  toggleExecApprovalAdvanced: (() => void) | null = () => {
    this.execApprovalShowAdvanced = !this.execApprovalShowAdvanced;
  };
  extendExecApprovalTimeout: (() => void) | null = null;
  clearExecApprovalHistory: (() => void) | null = () => {
    this.execApprovalHistory = [];
  };

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown | null = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  @state() configShowQuickSetup = this.settings.configShowQuickSetup;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;
  @state() channelWizardState: import("./views/channel-config-wizard").ChannelWizardState = {
    open: false,
    channelId: null,
    activeSection: "authentication",
    isDirty: false,
    showConfirmClose: false,
    pendingAction: null,
  };

  // Onboarding UX mode: "new" (simplified) or "legacy" (full options)
  @state() onboardingWizardState: import("./views/onboarding-wizard").OnboardingWizardState = {
    open: false,
    currentPhase: "quickstart",
    step: 1,
    totalSteps: 4,
    quickStartForm: {
      workspace: "~/clawdbot",
      authProvider: "anthropic",
      model: "claude-3-5-sonnet",
      gatewayPort: 18789,
      gatewayMode: "local",
      showAdvanced: false,
    },
    channelCards: [],
    modelCards: [],
    addModalOpen: false,
    addModalType: null,
    configModal: {
      open: false,
      itemId: null,
      itemName: "",
      itemIcon: "settings",
      isDirty: false,
      isSaving: false,
      showConfirmClose: false,
    },
    isDirty: false,
    isSaving: false,
    showConfirmClose: false,
    progress: null,
  };

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsUiSelectedAgentKey: string | null = null;
  @state() agentsUiAgentSearch = "";
  @state() agentsUiSessionSearch = "";
  @state() agentsUiSessionTypeFilter: "all" | "regular" | "cron" = "all";

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsSearch = "";
  @state() sessionsSort: "name" | "updated" | "tokens" | "status" | "kind" = "updated";
  @state() sessionsSortDir: "asc" | "desc" = "desc";
  @state() sessionsKindFilter: "all" | "direct" | "group" | "global" | "unknown" = "all";
  @state() sessionsStatusFilter: "all" | "active" | "idle" | "completed" = "all";
  @state() sessionsAgentLabelFilter = "";
  @state() sessionsLaneFilter: "all" | "cron" | "regular" = "all";
  @state() sessionsPreset: "all" | "active" | "errored" | "cron" | "custom" = this.settings.sessionsPreset;
  @state() sessionsShowAdvancedFilters = this.settings.sessionsShowAdvancedFilters;
  @state() sessionsTagFilter: string[] = [];
  @state() sessionsViewMode: "list" | "table" = readSessionsViewMode();
  @state() sessionsShowHidden: boolean = readBooleanStorage(SESSIONS_SHOW_HIDDEN_STORAGE_KEY, false);
  @state() sessionsAutoHideCompletedMinutes: number = readNumberStorage(
    SESSIONS_AUTO_HIDE_COMPLETED_MINUTES_KEY,
    0,
    0,
    10_080,
  );
  @state() sessionsAutoHideErroredMinutes: number = readNumberStorage(
    SESSIONS_AUTO_HIDE_ERRORED_MINUTES_KEY,
    0,
    0,
    10_080,
  );
  @state() sessionsDrawerKey: string | null = null;
  @state() sessionsDrawerExpanded = false;
  @state() sessionNavigator: SessionNavigatorState = createSessionNavigatorState();
  @state() sessionsPreviewLoading = false;
  @state() sessionsPreviewError: string | null = null;
  @state() sessionsPreviewEntry: SessionsPreviewEntry | null = null;
  @state() sessionsActiveTasksByKey: Map<string, SessionActiveTask[]> = new Map();
  private sessionsActiveTaskStateByKey = new Map<
    string,
    Map<
      string,
      SessionActiveTask & {
        lastSeenAt: number;
      }
    >
  >();
  private sessionsActiveTasksLastPruneAt = 0;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  // Automations state
  @state() automationsLoading = false;
  @state() automationsError: string | null = null;
  @state() automations: import("./controllers/automations").Automation[] = [];
  @state() automationsSearchQuery = "";
  @state() automationsStatusFilter: "all" | "active" | "suspended" | "error" = "all";
  @state() automationsSelectedId: string | null = null;
  @state() automationsExpandedIds: Set<string> = new Set();
  @state() automationsRunningIds: Set<string> = new Set();

  // Automation form state
  @state() automationFormOpen = false;
  @state() automationFormCurrentStep = 1;
  @state() automationFormErrors: Partial<Record<string, string>> = {};
  @state() automationFormData = {
    name: "",
    description: "",
    scheduleType: "every" as const,
    scheduleAt: "",
    scheduleEveryAmount: "1",
    scheduleEveryUnit: "hours" as const,
    scheduleCronExpr: "",
    scheduleCronTz: "",
    type: "smart-sync-fork" as const,
    config: {} as Record<string, unknown>,
  };

  // Automation progress modal state
  @state() automationProgressModalOpen = false;
  @state() automationProgressModalAutomationName = "";
  @state() automationProgressModalCurrentMilestone = "";
  @state() automationProgressModalProgress = 0;
  @state() automationProgressModalMilestones: import("./controllers/automations").AutomationRunMilestone[] = [];
  @state() automationProgressModalElapsedTime = "";
  @state() automationProgressModalConflicts = 0;
  @state() automationProgressModalStatus: "running" | "complete" | "failed" | "cancelled" = "running";
  @state() automationProgressModalSessionId = "";
  @state() automationProgressModalAutomationId = "";

  // Automation run history state
  @state() automationRunHistoryLoading = false;
  @state() automationRunHistoryError: string | null = null;
  @state() automationRunHistoryRecords: import("./controllers/automations").AutomationRunRecord[] = [];
  @state() automationRunHistoryExpandedRows: Set<string> = new Set();
  @state() automationRunHistoryCurrentPage = 1;
  @state() automationRunHistoryStatusFilter: 'all' | 'success' | 'failed' | 'running' = 'all';
  @state() automationRunHistoryDateFrom = "";
  @state() automationRunHistoryDateTo = "";
  @state() automationRunHistoryItemsPerPage = 10;
  @state() automationRunHistoryAutomationId: string | null = null;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown | null = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsPreset: "errors-only" | "warnings" | "debug" | "verbose" | "custom" = this.settings.logsPreset;
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;
  @state() logsShowRelativeTime = false;
  @state() logsShowSidebar = false;
  @state() logsShowFilters = true;
  @state() logsSubsystemFilters: Set<string> = new Set();
  private logsKeyboardCleanup: (() => void) | null = null;
  private configKeyboardCleanup: (() => void) | null = null;
  private overseerKeyboardCleanup: (() => void) | null = null;

  @state() overseerLoading = false;
  @state() overseerError: string | null = null;
  @state() overseerStatus: OverseerStatusResult | null = null;
  @state() overseerGoalLoading = false;
  @state() overseerGoalError: string | null = null;
  @state() overseerGoal: OverseerGoalStatusResult | null = null;
  @state() overseerSelectedGoalId: string | null = null;
  @state() overseerSelectedNodeId: string | null = null;
  @state() systemSelectedNodeId: string | null = null;
  @state() showOverseerGraph = true;
  @state() showSystemGraph = true;
  @state() overseerViewport: GraphViewport = { scale: 1, offsetX: 24, offsetY: 24 };
  @state() overseerDrag: GraphDragState | null = null;
  @state() systemViewport: GraphViewport = { scale: 1, offsetX: 24, offsetY: 24 };
  @state() systemDrag: GraphDragState | null = null;
  @state() overseerDrawerOpen = false;
  @state() overseerDrawerKind:
    | "cron"
    | "session"
    | "skill"
    | "channel"
    | "node"
    | "instance"
    | null = null;
  @state() overseerDrawerNodeId: string | null = null;

  // Goal management state
  @state() overseerGoalActionPending = false;
  @state() overseerGoalActionError: string | null = null;
  @state() overseerCreateGoalOpen = false;
  @state() overseerCreateGoalForm: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  } = {
    title: "",
    problemStatement: "",
    successCriteria: [],
    constraints: [],
    priority: "normal",
    generatePlan: true,
  };

  // Activity feed state
  @state() overseerActivityFilterStatus: string | null = null;
  @state() overseerActivityLimit = 50;

  // Simulator state
  @state() simulator: SimulatorState = createInitialSimulatorState();

  // Command palette state
  @state() commandPaletteOpen = false;
  @state() commandPaletteQuery = "";
  @state() commandPaletteSelectedIndex = 0;
  @state() commandPaletteFavVersion = 0;
  @state() commandPaletteCategory = "All";

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private overseerPollInterval: number | null = null;
  private automationsPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private speechRecognition: SpeechRecognitionLike | null = null;
  private audioDraftBase = "";
  private audioTranscriptFinal = "";
  private audioTranscriptInterim = "";
  private browserReadAloudSupported = false;
  private readAloudUtterance: SpeechSynthesisUtterance | null = null;
  private readAloudAudio: HTMLAudioElement | null = null;
  private readAloudAudioUrl: string | null = null;
  private ttsProvidersLoaded = false;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(
      this as unknown as Parameters<typeof onPopStateInternal>[0],
    );
  private hashChangeHandler = () =>
    onPopStateInternal(
      this as unknown as Parameters<typeof onPopStateInternal>[0],
    );
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;
  private commandPaletteKeyHandler = (e: KeyboardEvent) => {
    // Cmd/Ctrl + K to open command palette
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      if (this.commandPaletteOpen) {
        this.closeCommandPalette();
      } else {
        this.openCommandPalette();
      }
    }
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
    this.audioInputSupported = Boolean(resolveSpeechRecognitionCtor());
    this.browserReadAloudSupported = resolveSpeechSynthesisSupport();
    this.readAloudSupported = this.browserReadAloudSupported;
    window.addEventListener("keydown", this.commandPaletteKeyHandler);
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    this.stopAudioRecording();
    this.stopReadAloud();
    window.removeEventListener("keydown", this.commandPaletteKeyHandler);
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("connected")) {
      this.syncReadAloudSupport();
      if (!this.connected) {
        this.ttsProvidersLoaded = false;
      }
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(
      this as unknown as Parameters<typeof handleUpdated>[0],
      changed,
    );
    if (changed.has("connected") && this.connected) {
      void this.loadTtsProviders({ quiet: true });
      // Check if onboarding is needed after connection
      void this.checkOnboardingStatus();
    }
  }

  /**
   * Check if onboarding is needed after connection.
   * This is called after gateway connects and config is loaded.
   */
  async checkOnboardingStatus(): Promise<void> {
    if (!this.client || !this.connected) return;

    // Trigger config load if not already loaded
    if (!this.configSnapshot) {
      await loadConfig(this);
    }

    // Check if onboarding is needed
    if (shouldShowOnboarding(this.configSnapshot)) {
      // Show onboarding wizard
      void this.openOnboardingWizard();
    }
  }

  connect() {
    connectGatewayInternal(
      this as unknown as Parameters<typeof connectGatewayInternal>[0],
    );
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  jumpToLogsBottom() {
    jumpToLogsBottomInternal(
      this as unknown as Parameters<typeof jumpToLogsBottomInternal>[0],
    );
  }

  async clearLogs() {
    if (this.logsEntries.length === 0) return;
    const confirmed = await showDangerConfirmDialog(
      "Clear Logs",
      `Clear all ${this.logsEntries.length} log entries? This cannot be undone.`,
      "Clear",
    );
    if (!confirmed) return;
    this.logsEntries = [];
    this.logsCursor = null;
    this.logsTruncated = false;
    toast.success("Logs cleared");
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  handleLogsToggleSidebar() {
    this.logsShowSidebar = !this.logsShowSidebar;
  }

  handleLogsToggleFilters() {
    this.logsShowFilters = !this.logsShowFilters;
  }

  handleLogsSubsystemToggle(subsystem: string) {
    const next = new Set(this.logsSubsystemFilters);
    if (next.has(subsystem)) {
      next.delete(subsystem);
    } else {
      next.add(subsystem);
    }
    this.logsSubsystemFilters = next;
  }

  resetToolStream() {
    resetToolStreamInternal(
      this as unknown as Parameters<typeof resetToolStreamInternal>[0],
    );
  }

  handleAgentSessionActivity(payload?: AgentEventPayload) {
    if (!payload) return;
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
    if (!sessionKey) return;

    const now = Date.now();
    const STALE_MS = 6 * 60 * 60_000; // 6h
    const PRUNE_EVERY_MS = 30_000;

    if (now - this.sessionsActiveTasksLastPruneAt >= PRUNE_EVERY_MS) {
      this.sessionsActiveTasksLastPruneAt = now;
      let didPrune = false;
      for (const [key, tasks] of this.sessionsActiveTaskStateByKey) {
        for (const [taskKey, task] of tasks) {
          if (now - task.lastSeenAt > STALE_MS) {
            tasks.delete(taskKey);
            didPrune = true;
          }
        }
        if (tasks.size === 0) this.sessionsActiveTaskStateByKey.delete(key);
      }
      if (didPrune) {
        const next = new Map<string, SessionActiveTask[]>();
        for (const [key, tasks] of this.sessionsActiveTaskStateByKey) {
          next.set(
            key,
            [...tasks.values()].map(({ lastSeenAt: _, ...rest }) => rest),
          );
        }
        this.sessionsActiveTasksByKey = next;
      }
    }

    const stream = typeof payload.stream === "string" ? payload.stream : "";
    const data = payload.data ?? {};
    const phase = typeof data.phase === "string" ? data.phase : "";
    const runId = typeof payload.runId === "string" ? payload.runId : "";

    const ensureTasksMap = () => {
      const existing = this.sessionsActiveTaskStateByKey.get(sessionKey);
      if (existing) return existing;
      const created = new Map<string, SessionActiveTask & { lastSeenAt: number }>();
      this.sessionsActiveTaskStateByKey.set(sessionKey, created);
      return created;
    };

    let didChange = false;

    const ensureRunTask = (tasks: Map<string, SessionActiveTask & { lastSeenAt: number }>) => {
      if (!runId) return false;
      const key = `run:${runId}`;
      const existing = tasks.get(key);
      if (existing) {
        existing.lastSeenAt = now;
        return false;
      }
      tasks.set(key, {
        taskId: key,
        taskName: "Run",
        status: "in-progress",
        startedAt: typeof payload.ts === "number" ? payload.ts : now,
        lastSeenAt: now,
      });
      return true;
    };

    if (stream === "lifecycle") {
      if (!runId) return;
      const tasks = ensureTasksMap();
      const runKey = `run:${runId}`;
      if (phase === "start") {
        didChange = ensureRunTask(tasks);
      } else if (phase === "end") {
        let removed = tasks.delete(runKey);
        for (const key of [...tasks.keys()]) {
          if (
            key.startsWith(`${runId}:`) ||
            key === `compaction:${runId}` ||
            key.startsWith(`compaction:${runId}:`)
          ) {
            removed = tasks.delete(key) || removed;
          }
        }
        didChange = removed;
      } else {
        const existing = tasks.get(runKey);
        if (existing) {
          existing.lastSeenAt = now;
        }
      }
    } else if (stream === "tool") {
      const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
      if (!toolCallId) return;
      const toolName = typeof data.name === "string" ? data.name : "tool";
      const key = `${runId}:${toolCallId}`;
      const tasks = ensureTasksMap();
      const runChanged = ensureRunTask(tasks);

      if (phase === "result") {
        didChange = tasks.delete(key) || runChanged;
      } else {
        const existing = tasks.get(key);
        if (existing) {
          existing.lastSeenAt = now;
        } else {
          tasks.set(key, {
            taskId: key,
            taskName: toolName,
            status: "in-progress",
            startedAt: typeof payload.ts === "number" ? payload.ts : now,
            lastSeenAt: now,
          });
          didChange = true;
        }
        didChange = didChange || runChanged;
      }
    } else if (stream === "compaction") {
      const key = `compaction:${runId || "unknown"}`;
      const tasks = ensureTasksMap();
      const runChanged = ensureRunTask(tasks);
      if (phase === "end") {
        didChange = tasks.delete(key) || runChanged;
      } else if (phase === "start") {
        if (!tasks.has(key)) {
          tasks.set(key, {
            taskId: key,
            taskName: "Compaction",
            status: "in-progress",
            startedAt: typeof payload.ts === "number" ? payload.ts : now,
            lastSeenAt: now,
          });
          didChange = true;
        } else {
          const existing = tasks.get(key);
          if (existing) existing.lastSeenAt = now;
        }
        didChange = didChange || runChanged;
      } else {
        const existing = tasks.get(key);
        if (existing) {
          existing.lastSeenAt = now;
        }
        didChange = runChanged;
      }
    } else {
      const tasks = ensureTasksMap();
      didChange = ensureRunTask(tasks);
    }

    if (!didChange) return;

    const tasks = this.sessionsActiveTaskStateByKey.get(sessionKey);
    if (tasks && tasks.size === 0) this.sessionsActiveTaskStateByKey.delete(sessionKey);

    const next = new Map(this.sessionsActiveTasksByKey);
    const list = tasks
      ? [...tasks.values()].map(({ lastSeenAt: _, ...rest }) => rest)
      : [];
    if (list.length === 0) next.delete(sessionKey);
    else next.set(sessionKey, list);
    this.sessionsActiveTasksByKey = next;
  }

  resetChatScroll() {
    resetChatScrollInternal(
      this as unknown as Parameters<typeof resetChatScrollInternal>[0],
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(
      this as unknown as Parameters<typeof applySettingsInternal>[0],
      next,
    );
  }

  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(
      this as unknown as Parameters<typeof setThemeInternal>[0],
      next,
      context,
    );
  }

  async loadOverview() {
    await loadOverviewInternal(
      this as unknown as Parameters<typeof loadOverviewInternal>[0],
    );
  }

  async loadCron() {
    await loadCronInternal(
      this as unknown as Parameters<typeof loadCronInternal>[0],
    );
  }

  // Helper methods to persist state changes to localStorage
  persistLogsPreset(preset: typeof this.logsPreset) {
    this.applySettings({ ...this.settings, logsPreset: preset });
  }

  persistSessionsPreset(preset: typeof this.sessionsPreset) {
    this.applySettings({ ...this.settings, sessionsPreset: preset });
  }

  persistOverviewShowSystemMetrics(show: boolean) {
    this.applySettings({ ...this.settings, overviewShowSystemMetrics: show });
  }

  persistConfigShowQuickSetup(show: boolean) {
    this.applySettings({ ...this.settings, configShowQuickSetup: show });
  }

  persistNavShowAdvanced(show: boolean) {
    this.applySettings({ ...this.settings, navShowAdvanced: show });
  }

  persistSessionsShowAdvancedFilters(show: boolean) {
    this.applySettings({ ...this.settings, sessionsShowAdvancedFilters: show });
  }

  async handleAbortChat() {
    await handleAbortChatInternal(
      this as unknown as Parameters<typeof handleAbortChatInternal>[0],
    );
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async loadTtsProviders(opts?: { quiet?: boolean }) {
    await loadTtsProvidersInternal(
      this as unknown as Parameters<typeof loadTtsProvidersInternal>[0],
      opts,
    );
    if (this.ttsProviders.length > 0) {
      this.ttsProvidersLoaded = true;
    }
    this.syncReadAloudSupport();
  }

  handleTtsProviderChange(provider: TtsProviderId) {
    void this.setTtsProvider(provider);
  }

  private async setTtsProvider(provider: TtsProviderId) {
    await setTtsProviderInternal(
      this as unknown as Parameters<typeof setTtsProviderInternal>[0],
      provider,
    );
    if (this.ttsProviders.length > 0) {
      this.ttsProvidersLoaded = true;
    }
    this.syncReadAloudSupport();
  }

  private hasConfiguredTtsProviders(): boolean {
    return this.ttsProviders.some((provider) => provider.configured);
  }

  private syncReadAloudSupport() {
    this.readAloudSupported =
      this.browserReadAloudSupported || (this.connected && this.hasConfiguredTtsProviders());
  }

  private async ensureTtsProvidersLoaded() {
    if (!this.connected || !this.client) return;
    if (this.ttsProvidersLoaded || this.ttsLoading) return;
    await this.loadTtsProviders({ quiet: true });
  }

  handleToggleAudioRecording() {
    if (this.audioRecording) {
      this.stopAudioRecording();
      return;
    }
    if (!this.audioInputSupported) {
      this.audioInputError = "Audio input is not supported in this browser.";
      return;
    }
    this.startAudioRecording();
  }

  handleReadAloudToggle(textOverride?: string | null) {
    if (this.readAloudActive) {
      this.stopReadAloud();
      return;
    }
    const text = textOverride?.trim() || this.resolveReadAloudText();
    if (!text) {
      this.readAloudError = "No assistant reply to read yet.";
      return;
    }
    this.readAloudError = null;
    void this.startReadAloud(text);
  }

  private startAudioRecording() {
    const ctor = resolveSpeechRecognitionCtor();
    if (!ctor) {
      this.audioInputSupported = false;
      this.audioInputError = "Speech recognition is unavailable.";
      return;
    }

    this.audioInputError = null;
    this.audioDraftBase = this.chatMessage.trim();
    this.audioTranscriptFinal = "";
    this.audioTranscriptInterim = "";

    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event) => {
      this.handleSpeechResult(event);
    };

    recognition.onerror = (event) => {
      const error = event?.error ? String(event.error) : "Speech recognition failed.";
      this.audioInputError = error;
    };

    recognition.onend = () => {
      this.audioRecording = false;
      this.audioTranscriptInterim = "";
      this.speechRecognition = null;
    };

    this.speechRecognition = recognition;
    this.audioRecording = true;

    try {
      recognition.start();
    } catch (err) {
      this.audioRecording = false;
      this.speechRecognition = null;
      this.audioInputError = err instanceof Error ? err.message : String(err);
    }
  }

  private stopAudioRecording() {
    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch {
        // ignore
      }
    }
    this.audioRecording = false;
    this.audioTranscriptInterim = "";
    this.speechRecognition = null;
  }

  private handleSpeechResult(event: SpeechRecognitionEventLike) {
    const results = event.results;
    if (!results) return;
    const startIndex = typeof event.resultIndex === "number" ? event.resultIndex : 0;
    let interim = "";
    let finalChunk = "";

    for (let i = startIndex; i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      const transcript = result[0]?.transcript?.trim();
      if (!transcript) continue;
      if (result.isFinal) {
        finalChunk = `${finalChunk} ${transcript}`.trim();
      } else {
        interim = `${interim} ${transcript}`.trim();
      }
    }

    if (finalChunk) {
      this.audioTranscriptFinal = `${this.audioTranscriptFinal} ${finalChunk}`.trim();
    }
    this.audioTranscriptInterim = interim;
    this.updateAudioDraft();
  }

  private updateAudioDraft() {
    const transcript = [this.audioTranscriptFinal, this.audioTranscriptInterim]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!transcript) {
      this.chatMessage = this.audioDraftBase;
      return;
    }
    this.chatMessage = this.audioDraftBase
      ? `${this.audioDraftBase}\n${transcript}`.trim()
      : transcript;
  }

  private resolveReadAloudText(): string | null {
    for (let i = this.chatMessages.length - 1; i >= 0; i -= 1) {
      const message = this.chatMessages[i];
      const normalized = normalizeMessage(message);
      const role = normalizeRoleForGrouping(normalized.role);
      if (role !== "assistant") continue;
      const text = extractText(message)?.trim();
      if (text) return text;
    }
    return null;
  }

  private async startReadAloud(text: string) {
    await this.ensureTtsProvidersLoaded();
    if (this.connected && this.hasConfiguredTtsProviders()) {
      const ok = await this.startReadAloudServer(text);
      if (ok) return;
    }
    if (this.browserReadAloudSupported) {
      this.startReadAloudBrowser(text);
      return;
    }
    if (!this.readAloudError) {
      this.readAloudError = "Read-aloud is not supported in this browser.";
    }
  }

  private async startReadAloudServer(text: string): Promise<boolean> {
    if (!this.client || !this.connected) return false;
    try {
      const res = (await this.client.request("tts.convert", {
        text,
        channel: "web",
        returnBase64: true,
      })) as { audioBase64?: unknown; audioMime?: unknown };
      const base64 = typeof res?.audioBase64 === "string" ? res.audioBase64 : "";
      if (!base64) {
        throw new Error("Server did not return audio.");
      }
      const mime =
        typeof res.audioMime === "string" && res.audioMime.trim()
          ? res.audioMime.trim()
          : "audio/mpeg";
      this.stopReadAloud();
      const audio = this.buildReadAloudAudio(base64, mime);
      audio.onended = () => {
        this.readAloudActive = false;
        this.cleanupReadAloudAudio();
      };
      audio.onerror = () => {
        this.readAloudActive = false;
        this.cleanupReadAloudAudio();
        this.readAloudError = "Read-aloud failed.";
      };
      this.readAloudAudio = audio;
      await audio.play();
      this.readAloudActive = true;
      this.readAloudError = null;
      return true;
    } catch (err) {
      this.readAloudActive = false;
      this.cleanupReadAloudAudio();
      this.readAloudError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private startReadAloudBrowser(text: string) {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      this.readAloudError = "Speech synthesis is unavailable.";
      return;
    }
    this.stopReadAloud();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      this.readAloudActive = false;
      this.readAloudUtterance = null;
    };
    utterance.onerror = () => {
      this.readAloudActive = false;
      this.readAloudUtterance = null;
      this.readAloudError = "Read-aloud failed.";
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    this.readAloudUtterance = utterance;
    this.readAloudActive = true;
    this.readAloudError = null;
  }

  private stopReadAloud() {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (this.readAloudAudio) {
      this.readAloudAudio.pause();
    }
    this.cleanupReadAloudAudio();
    this.readAloudActive = false;
    this.readAloudUtterance = null;
  }

  private buildReadAloudAudio(base64: string, mime: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    this.readAloudAudioUrl = URL.createObjectURL(blob);
    return new Audio(this.readAloudAudioUrl);
  }

  private cleanupReadAloudAudio() {
    if (this.readAloudAudio) {
      this.readAloudAudio.src = "";
      this.readAloudAudio = null;
    }
    if (this.readAloudAudioUrl) {
      URL.revokeObjectURL(this.readAloudAudioUrl);
      this.readAloudAudioUrl = null;
    }
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  handleChannelWizardOpen(channelId: string) {
    this.channelWizardState = {
      ...this.channelWizardState,
      open: true,
      channelId,
      activeSection: "authentication",
      isDirty: false,
      showConfirmClose: false,
      pendingAction: null,
    };
  }

  handleChannelWizardClose() {
    this.channelWizardState = {
      ...this.channelWizardState,
      open: false,
      showConfirmClose: false,
      pendingAction: null,
    };
  }

  async handleChannelWizardSave() {
    await handleChannelConfigSaveInternal(this);
    this.channelWizardState = {
      ...this.channelWizardState,
      isDirty: false,
    };
  }

  handleChannelWizardDiscard() {
    // Reload config to revert changes
    handleChannelConfigReloadInternal(this);
    this.channelWizardState = {
      ...this.channelWizardState,
      isDirty: false,
      open: false,
      showConfirmClose: false,
      pendingAction: null,
    };
  }

  handleChannelWizardSectionChange(sectionId: string) {
    this.channelWizardState = {
      ...this.channelWizardState,
      activeSection: sectionId,
    };
  }

  handleChannelWizardConfirmClose() {
    this.channelWizardState = {
      ...this.channelWizardState,
      showConfirmClose: true,
    };
  }

  handleChannelWizardCancelClose() {
    this.channelWizardState = {
      ...this.channelWizardState,
      showConfirmClose: false,
      pendingAction: null,
    };
  }

  // ============================================================================
  // Onboarding Wizard Handlers
  // ============================================================================

  async openOnboardingWizard() {
    this.onboarding = true;
    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      open: true,
      currentPhase: "quick-start",
    };
    // Refresh cards to show current config state
    await this.refreshOnboardingCards();
  }

  handleOnboardingWizardClose() {
    this.onboarding = false;
    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      open: false,
      showConfirmClose: false,
    };
  }

  async handleOnboardingWizardNext() {
    const { currentPhase, progress } = this.onboardingWizardState;
    const completedPhases = progress?.completedPhases ?? [];
    const phases = ["quick-start", "channels", "models", "ready"];
    const currentIndex = phases.indexOf(currentPhase);

    if (currentIndex < phases.length - 1) {
      const nextPhase = phases[currentIndex + 1];

      // Save onboarding progress before advancing
      if (!completedPhases.includes(currentPhase)) {
        await this.saveOnboardingProgress(currentPhase, nextPhase);
      }

      // Refresh cards when entering channels or models phase
      if (nextPhase === "channels" || nextPhase === "models") {
        await this.refreshOnboardingCards();
      }

      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        currentPhase: nextPhase,
        progress: {
          startedAt: progress?.startedAt ?? new Date().toISOString(),
          completedPhases: completedPhases.includes(currentPhase)
            ? completedPhases
            : [...completedPhases, currentPhase],
          lastSavedAt: new Date().toISOString(),
        },
      };
    }
  }

  async saveOnboardingProgress(currentPhase: string, nextPhase: string) {
    if (!this.client || !this.connected || !this.configSnapshot) return;

    try {
      const { progress } = this.onboardingWizardState;
      const completedPhases = progress?.completedPhases ?? [];
      const config = this.configSnapshot.config as Record<string, unknown> | undefined;

      // Build or update onboarding metadata
      const wizard = (config?.wizard as Record<string, unknown>) ?? {};
      const existingOnboarding = wizard.onboarding as {
        startedAt?: string;
        completedPhases?: string[];
        currentPhase?: string;
        phaseData?: Record<string, unknown>;
      } | undefined;

      const updatedCompletedPhases = existingOnboarding?.completedPhases ?? [];
      if (!updatedCompletedPhases.includes(currentPhase)) {
        updatedCompletedPhases.push(currentPhase);
      }

      const onboardingMetadata = {
        startedAt: existingOnboarding?.startedAt ?? new Date().toISOString(),
        currentPhase: nextPhase,
        completedPhases: updatedCompletedPhases,
        phaseData: {
          ...(existingOnboarding?.phaseData ?? {}),
          [currentPhase]: {
            completedAt: new Date().toISOString(),
          },
        },
        lastSavedAt: new Date().toISOString(),
      };

      // Use config.patch to incrementally update just the wizard.onboarding field
      const baseHash = this.configSnapshot.hash;
      if (!baseHash) {
        console.error("Config hash missing; cannot save onboarding progress");
        return;
      }

      const patch = {
        wizard: {
          ...(config?.wizard as Record<string, unknown> ?? {}),
          onboarding: onboardingMetadata,
        },
      };

      const raw = JSON.stringify(patch, null, 2);
      await this.client.request("config.patch", { raw, baseHash });

      // Reload config to get updated hash
      await loadConfig(this);
    } catch (err) {
      console.error("Failed to save onboarding progress:", err);
    }
  }

  async handleOnboardingWizardBack() {
    const { currentPhase } = this.onboardingWizardState;
    const phases = ["quick-start", "channels", "models", "ready"];
    const currentIndex = phases.indexOf(currentPhase);

    if (currentIndex > 0) {
      const prevPhase = phases[currentIndex - 1];

      // Refresh cards when going back to channels or models phase
      if (prevPhase === "channels" || prevPhase === "models") {
        await this.refreshOnboardingCards();
      }

      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        currentPhase: prevPhase,
      };
    }
  }

  handleOnboardingWizardSkip() {
    const { currentPhase } = this.onboardingWizardState;
    const phases = ["quick-start", "channels", "models", "ready"];
    const currentIndex = phases.indexOf(currentPhase);

    if (currentIndex < phases.length - 1) {
      const nextPhase = phases[currentIndex + 1];
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        currentPhase: nextPhase,
      };
    }
  }

  updateQuickStartFormValue(path: string[], value: unknown) {
    const { quickStartForm } = this.onboardingWizardState;
    const updated = { ...quickStartForm };
    let current: Record<string, unknown> = updated;

    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[path[path.length - 1]] = value;

    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      quickStartForm: updated,
    };
  }

  handleOpenChannelConfigModal(channelId: string) {
    const { channelCards } = this.onboardingWizardState;
    const channel = channelCards.find((c) => c.id === channelId);

    if (channel) {
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        configModal: {
          ...this.onboardingWizardState.configModal,
          open: true,
          itemId: channelId,
          itemName: channel.name,
          itemIcon: channel.icon,
          isDirty: false,
        },
      };
    }
  }

  handleOpenModelConfigModal(modelId: string) {
    const { modelCards } = this.onboardingWizardState;
    const model = modelCards.find((m) => m.id === modelId);

    if (model) {
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        configModal: {
          ...this.onboardingWizardState.configModal,
          open: true,
          itemId: modelId,
          itemName: model.name,
          itemIcon: model.icon,
          isDirty: false,
        },
      };
    }
  }

  handleAddChannelFromModal(channelId: string) {
    // Close the add modal and open the config modal for the selected channel
    const { channelCards } = this.onboardingWizardState;

    // If channel doesn't exist in cards, create a placeholder card
    let channel = channelCards.find((c) => c.id === channelId);
    if (!channel) {
      const channelDef = this.onboardingWizardState.channelCards.find((c) => c.id === channelId);
      if (channelDef) {
        channel = channelDef;
      }
    }

    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      addModalOpen: false,
      addModalType: null,
      configModal: {
        ...this.onboardingWizardState.configModal,
        open: true,
        itemId: channelId,
        itemName: channel?.name || channelId,
        itemIcon: channel?.icon || "message-square",
        isDirty: false,
      },
    };
  }

  handleAddModelFromModal(modelId: string) {
    // Close the add modal and open the config modal for the selected model
    const { modelCards } = this.onboardingWizardState;

    // If model doesn't exist in cards, create a placeholder card
    let model = modelCards.find((m) => m.id === modelId);
    if (!model) {
      const modelDef = this.onboardingWizardState.modelCards.find((m) => m.id === modelId);
      if (modelDef) {
        model = modelDef;
      }
    }

    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      addModalOpen: false,
      addModalType: null,
      configModal: {
        ...this.onboardingWizardState.configModal,
        open: true,
        itemId: modelId,
        itemName: model?.name || modelId,
        itemIcon: model?.icon || "cpu",
        isDirty: false,
      },
    };
  }

  async handleRemoveChannel(channelId: string) {
    if (!this.client || !this.connected || !this.configSnapshot) return;

    try {
      const config = this.configSnapshot.config as Record<string, unknown>;
      const channels = (config.channels as Record<string, unknown>) ?? {};

      // Remove the channel from config
      delete channels[channelId];

      const baseHash = this.configSnapshot.hash;
      if (!baseHash) {
        console.error("Config hash missing; cannot remove channel");
        return;
      }

      const patch = { channels };
      const raw = JSON.stringify(patch, null, 2);
      await this.client.request("config.patch", { raw, baseHash });

      // Reload config and refresh cards
      await loadConfig(this);
      await this.refreshOnboardingCards();
    } catch (err) {
      console.error("Failed to remove channel:", err);
    }
  }

  async handleRemoveModel(modelId: string) {
    // For now, models can't be removed if they're the default
    // This would be expanded when we support multiple models
    const config = this.configSnapshot?.config as Record<string, unknown> | undefined;
    const defaultModel = config?.agents?.defaults?.model;

    if (defaultModel === modelId) {
      console.error("Cannot remove default model");
      return;
    }

    // TODO: Implement model removal when we support multiple models
    console.log("Model removal not yet implemented for non-default models");
  }

  async handleSaveConfigModal() {
    const { configModal } = this.onboardingWizardState;

    if (!configModal.itemId || !this.client || !this.connected || !this.configSnapshot) return;

    try {
      // Get the current config form as the updated config
      const baseHash = this.configSnapshot.hash;
      if (!baseHash) {
        console.error("Config hash missing; cannot save config");
        return;
      }

      // Serialize the current config form
      const serialized = JSON.stringify(this.configForm ?? {}, null, 2);
      await this.client.request("config.set", { raw: serialized, baseHash });

      // Reload config to get updated hash and refresh card states
      await loadConfig(this);

      // Refresh the affected card (will be re-rendered with new config)
      await this.refreshOnboardingCards();

      // Close the modal
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        configModal: {
          ...configModal,
          open: false,
          isDirty: false,
          itemId: null,
        },
      };
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }

  async refreshOnboardingCards() {
    if (!this.configSnapshot?.config) return;

    const config = this.configSnapshot.config as Record<string, unknown>;

    // Import the helper functions from onboarding-phases
    const { getChannelCards, getModelCards } = await import("./views/onboarding-phases");

    // Refresh channel cards based on current config
    const channelCards = getChannelCards(config);

    // Refresh model cards based on current config
    const modelCards = getModelCards(config);

    // Update wizard state with refreshed cards
    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      channelCards,
      modelCards,
    };
  }

  handleConfigModalClose() {
    const { configModal } = this.onboardingWizardState;

    if (configModal.isDirty) {
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        configModal: {
          ...configModal,
          showConfirmClose: true,
        },
      };
    } else {
      this.onboardingWizardState = {
        ...this.onboardingWizardState,
        configModal: {
          ...configModal,
          open: false,
          itemId: null,
        },
      };
    }
  }

  handleConfigModalCancelClose() {
    this.onboardingWizardState = {
      ...this.onboardingWizardState,
      configModal: {
        ...this.onboardingWizardState.configModal,
        showConfirmClose: false,
      },
    };
  }

  async handleOverseerRefresh() {
    await refreshOverseerInternal(this);
  }

  async handleOverseerTick() {
    await tickOverseerInternal(this, "manual");
    await refreshOverseerInternal(this, { quiet: true });
  }

  async handleOverseerSelectGoal(goalId: string | null) {
    this.overseerSelectedGoalId = goalId;
    this.overseerSelectedNodeId = null;
    if (!goalId) {
      this.overseerGoal = null;
      return;
    }
    await loadOverseerGoal(this, goalId);
  }

  handleOverseerSelectOverseerNode(nodeId: string | null) {
    this.overseerSelectedNodeId = nodeId;
  }

  handleOverseerSelectSystemNode(nodeId: string | null) {
    this.systemSelectedNodeId = nodeId;
    if (!nodeId) {
      this.overseerDrawerOpen = false;
      this.overseerDrawerKind = null;
      this.overseerDrawerNodeId = null;
      return;
    }
    const separator = nodeId.indexOf(":");
    const kind = separator === -1 ? nodeId : nodeId.slice(0, separator);
    const resolvedId = separator === -1 ? "" : nodeId.slice(separator + 1);
    switch (kind) {
      case "cron":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "cron";
        this.overseerDrawerNodeId = resolvedId;
        void loadCronRuns(this, resolvedId);
        break;
      case "session":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "session";
        this.overseerDrawerNodeId = resolvedId;
        break;
      case "skill":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "skill";
        this.overseerDrawerNodeId = resolvedId;
        break;
      case "channel":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "channel";
        this.overseerDrawerNodeId = resolvedId;
        break;
      case "node":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "node";
        this.overseerDrawerNodeId = resolvedId;
        break;
      case "instance":
        this.overseerDrawerOpen = true;
        this.overseerDrawerKind = "instance";
        this.overseerDrawerNodeId = resolvedId;
        break;
      default:
        this.overseerDrawerOpen = false;
        this.overseerDrawerKind = null;
        this.overseerDrawerNodeId = null;
        break;
    }
  }

  handleOverseerViewportChange(kind: "overseer" | "system", next: GraphViewport) {
    if (kind === "overseer") {
      this.overseerViewport = next;
    } else {
      this.systemViewport = next;
    }
  }

  handleOverseerDragChange(kind: "overseer" | "system", next: GraphDragState | null) {
    if (kind === "overseer") {
      this.overseerDrag = next;
    } else {
      this.systemDrag = next;
    }
  }

  handleOverseerToggleGraph(kind: "overseer" | "system", next: boolean) {
    if (kind === "overseer") {
      this.showOverseerGraph = next;
    } else {
      this.showSystemGraph = next;
    }
  }

  handleOverseerDrawerClose() {
    this.overseerDrawerOpen = false;
    this.overseerDrawerKind = null;
    this.overseerDrawerNodeId = null;
  }

  handleSessionsDrawerClose() {
    this.sessionsDrawerKey = null;
    this.sessionsDrawerExpanded = false;
    this.sessionsPreviewLoading = false;
    this.sessionsPreviewError = null;
    this.sessionsPreviewEntry = null;
  }

  handleSessionsDrawerToggleExpanded() {
    this.sessionsDrawerExpanded = !this.sessionsDrawerExpanded;
  }

  async handleSessionsDrawerOpen(key: string) {
    const trimmed = key.trim();
    if (!trimmed) return;
    if (this.sessionsDrawerKey === trimmed) return;
    this.sessionsDrawerKey = trimmed;
    this.sessionsDrawerExpanded = false;
    this.sessionsPreviewEntry = null;
    this.sessionsPreviewError = null;
    await this.handleSessionsDrawerRefreshPreview();
  }

  async handleSessionsDrawerOpenExpanded(key: string) {
    const trimmed = key.trim();
    if (!trimmed) return;
    if (this.sessionsDrawerKey !== trimmed) {
      await this.handleSessionsDrawerOpen(trimmed);
    }
    this.sessionsDrawerExpanded = true;
  }

  async handleSessionsDrawerRefreshPreview() {
    const key = this.sessionsDrawerKey;
    if (!key || !this.client || !this.connected) return;
    if (this.sessionsPreviewLoading) return;
    this.sessionsPreviewLoading = true;
    this.sessionsPreviewError = null;
    this.sessionsPreviewEntry = null;
    const requestKey = key;
    try {
      const res = (await this.client.request("sessions.preview", {
        keys: [requestKey],
        limit: 24,
        maxChars: 280,
      })) as SessionsPreviewResult | undefined;
      if (this.sessionsDrawerKey !== requestKey) return;
      this.sessionsPreviewEntry =
        res?.previews?.find((entry) => entry.key === requestKey) ?? null;
    } catch (err) {
      if (this.sessionsDrawerKey !== requestKey) return;
      this.sessionsPreviewError = String(err);
      this.sessionsPreviewEntry = null;
    } finally {
      if (this.sessionsDrawerKey === requestKey) this.sessionsPreviewLoading = false;
    }
  }

  async handleOverseerLoadCronRuns(jobId: string) {
    await loadCronRuns(this, jobId);
  }

  // Goal management handlers
  async handleOverseerPauseGoal(goalId: string) {
    await pauseOverseerGoalInternal(this, goalId);
  }

  async handleOverseerResumeGoal(goalId: string) {
    await resumeOverseerGoalInternal(this, goalId);
  }

  handleOverseerOpenCreateGoal() {
    this.overseerCreateGoalOpen = true;
    this.overseerCreateGoalForm = {
      title: "",
      problemStatement: "",
      successCriteria: [],
      constraints: [],
      priority: "normal",
      generatePlan: true,
    };
  }

  handleOverseerCloseCreateGoal() {
    this.overseerCreateGoalOpen = false;
  }

  async handleOverseerCreateGoal(params: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  }) {
    await createOverseerGoalInternal(this, params);
  }

  handleOverseerUpdateCreateGoalForm(updates: Record<string, unknown>) {
    this.overseerCreateGoalForm = {
      ...this.overseerCreateGoalForm,
      ...updates,
    };
  }

  async handleOverseerMarkWorkDone(goalId: string, workNodeId: string, summary?: string) {
    await updateOverseerWorkNodeInternal(this, { goalId, workNodeId, status: "done", summary });
  }

  async handleOverseerBlockWork(goalId: string, workNodeId: string, reason: string) {
    await updateOverseerWorkNodeInternal(this, { goalId, workNodeId, status: "blocked", blockedReason: reason });
  }

  async handleOverseerRetryAssignment(goalId: string, workNodeId: string) {
    await retryOverseerAssignmentInternal(this, { goalId, workNodeId });
  }

  handleOverseerActivityFilterChange(status: string | null) {
    this.overseerActivityFilterStatus = status;
  }

  handleOverseerActivityLimitChange(limit: number) {
    this.overseerActivityLimit = limit;
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-session" | "allow-always" | "deny" | "deny-always") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) return;
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) return;
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  // Task sidebar handlers
  handleOpenTaskSidebar() {
    this.taskSidebarOpen = true;
    this.syncTasksFromToolStream();
  }

  handleCloseTaskSidebar() {
    this.taskSidebarOpen = false;
  }

  handleToggleTaskExpanded(taskId: string) {
    const next = new Set(this.taskSidebarExpandedIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    this.taskSidebarExpandedIds = next;
  }

  syncTasksFromToolStream() {
    const entries = Array.from(this.toolStreamById.values());
    const { tasks, activityLog } = deriveTasksFromToolStream(entries);
    this.chatTasks = tasks;
    this.chatActivityLog = activityLog;
  }

  // Command palette handlers
  openCommandPalette() {
    this.commandPaletteOpen = true;
    this.commandPaletteQuery = "";
    this.commandPaletteSelectedIndex = 0;
    this.commandPaletteCategory = "All";
  }

  closeCommandPalette() {
    this.commandPaletteOpen = false;
    this.commandPaletteQuery = "";
    this.commandPaletteSelectedIndex = 0;
    this.commandPaletteCategory = "All";
  }

  setCommandPaletteQuery(query: string) {
    this.commandPaletteQuery = query;
  }

  setCommandPaletteSelectedIndex(index: number) {
    this.commandPaletteSelectedIndex = index;
  }

  bumpCommandPaletteFavVersion() {
    this.commandPaletteFavVersion++;
  }

  setCommandPaletteCategory(category: string) {
    this.commandPaletteCategory = category;
  }

  render() {
    return renderApp(this);
  }
}
