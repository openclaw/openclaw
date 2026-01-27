import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { Tab } from "./navigation";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  AgentsListResult,
  ChannelsStatusSnapshot,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  NostrProfile,
  PresenceEntry,
  SessionsListResult,
  SessionsPreviewEntry,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatAttachment, ChatQueueItem, CronFormState, GraphDragState, GraphViewport } from "./ui-types";
import type { EventLogEntry } from "./app-events";
import type { SkillMessage } from "./controllers/skills";
import type { TtsProviderId, TtsProviderInfo } from "./controllers/tts";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "./controllers/exec-approvals";
import type { DevicePairingList } from "./controllers/devices";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form";
import type { ChannelWizardState } from "./views/channel-config-wizard";
import type { CompactionStatus } from "./app-tool-stream";
import type { ChatTask, ChatActivityLog } from "./types/task-types";
import type { SessionActiveTask } from "./views/sessions";
import type { SessionNavigatorState } from "./components/session-navigator";
import type {
  OverseerGoalStatusResult,
  OverseerStatusResult,
} from "./types/overseer";
import type { SimulatorState } from "./types/overseer-simulator";
import type {
  Automation,
  AutomationRunMilestone,
  AutomationRunRecord,
  AutomationStatus,
  AutomationType,
} from "./controllers/automations";
import type { ExecApprovalHistoryEntry } from "./views/exec-approval";

export type AppViewState = {
  settings: UiSettings;
  password: string;
  overviewShowSystemMetrics: boolean;
  tab: Tab;
  navShowAdvanced: boolean;
  onboarding: boolean;
  basePath: string;
  connected: boolean;
  theme: ThemeMode;
  themeResolved: "light" | "dark";
  hello: GatewayHelloOk | null;
  lastError: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  applySessionKey: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  chatRunId: string | null;
  chatAvatarUrl: string | null;
  chatThinkingLevel: string | null;
  chatQueue: ChatQueueItem[];
  chatStreamStartedAt: number | null;
  compactionStatus: CompactionStatus | null;
  audioInputSupported: boolean;
  audioRecording: boolean;
  audioInputError: string | null;
  readAloudSupported: boolean;
  readAloudActive: boolean;
  readAloudError: string | null;
  ttsLoading: boolean;
  ttsError: string | null;
  ttsProviders: TtsProviderInfo[];
  ttsActiveProvider: TtsProviderId | null;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormMode: "form" | "raw";
  configSchemaVersion: string | null;
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  configShowQuickSetup: boolean;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  channelWizardState: ChannelWizardState;
  configFormDirty: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsUiSelectedAgentKey: string | null;
  agentsUiAgentSearch: string;
  agentsUiSessionSearch: string;
  agentsUiSessionTypeFilter: "all" | "regular" | "cron";
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsSearch: string;
  sessionsSort: "name" | "updated" | "tokens" | "status" | "kind";
  sessionsSortDir: "asc" | "desc";
  sessionsKindFilter: "all" | "direct" | "group" | "global" | "unknown";
  sessionsStatusFilter: "all" | "active" | "idle" | "completed";
  sessionsAgentLabelFilter: string;
  sessionsLaneFilter: "all" | "cron" | "regular";
  sessionsPreset: "all" | "active" | "errored" | "cron" | "custom";
  sessionsShowAdvancedFilters: boolean;
  sessionsTagFilter: string[];
  sessionsViewMode: "list" | "table";
  sessionsShowHidden: boolean;
  sessionsAutoHideCompletedMinutes: number;
  sessionsAutoHideErroredMinutes: number;
  sessionsDrawerKey: string | null;
  sessionsDrawerExpanded: boolean;
  // Session navigator (chat controls dropdown)
  sessionNavigator: SessionNavigatorState;
  sessionsPreviewLoading: boolean;
  sessionsPreviewError: string | null;
  sessionsPreviewEntry: SessionsPreviewEntry | null;
  sessionsActiveTasksByKey: Map<string, SessionActiveTask[]>;
  cronLoading: boolean;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  cronBusy: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillEdits: Record<string, string>;
  skillMessages: Record<string, SkillMessage>;
  skillsBusyKey: string | null;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown | null;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  logsLoading: boolean;
  logsError: string | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsCursor: number | null;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
  logsFilterText: string;
  logsLevelFilters: Record<LogLevel, boolean>;
  logsPreset: "errors-only" | "warnings" | "debug" | "verbose" | "custom";
  logsAutoFollow: boolean;
  logsTruncated: boolean;
  logsShowRelativeTime: boolean;
  logsShowSidebar: boolean;
  logsShowFilters: boolean;
  logsSubsystemFilters: Set<string>;
  logsAtBottom: boolean;
  overseerLoading: boolean;
  overseerError: string | null;
  overseerStatus: OverseerStatusResult | null;
  overseerGoalLoading: boolean;
  overseerGoalError: string | null;
  overseerGoal: OverseerGoalStatusResult | null;
  overseerSelectedGoalId: string | null;
  overseerSelectedNodeId: string | null;
  systemSelectedNodeId: string | null;
  showOverseerGraph: boolean;
  showSystemGraph: boolean;
  overseerViewport: GraphViewport;
  overseerDrag: GraphDragState | null;
  systemViewport: GraphViewport;
  systemDrag: GraphDragState | null;
  overseerDrawerOpen: boolean;
  overseerDrawerKind:
    | "cron"
    | "session"
    | "skill"
    | "channel"
    | "node"
    | "instance"
    | null;
  overseerDrawerNodeId: string | null;
  // Goal management state
  overseerGoalActionPending: boolean;
  overseerGoalActionError: string | null;
  overseerCreateGoalOpen: boolean;
  overseerCreateGoalForm: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  };
  overseerActivityFilterStatus: string | null;
  overseerActivityLimit: number;
  // Simulator state
  simulator: SimulatorState;
  // Automations state
  automations: Automation[];
  automationsSearchQuery: string;
  automationsStatusFilter: "all" | AutomationStatus;
  automationsLoading: boolean;
  automationsError: string | null;
  automationsSelectedId: string | null;
  automationsExpandedIds: Set<string>;
  automationsRunningIds: Set<string>;
  // Automation form state
  automationFormOpen: boolean;
  automationFormCurrentStep: number;
  automationFormErrors: Partial<Record<string, string>>;
  automationFormData: {
    name: string;
    description: string;
    scheduleType: "at" | "every" | "cron";
    scheduleAt: string;
    scheduleEveryAmount: string;
    scheduleEveryUnit: "minutes" | "hours" | "days";
    scheduleCronExpr: string;
    scheduleCronTz: string;
    type: AutomationType;
    config: Record<string, unknown>;
  };
  // Automation progress modal state
  automationProgressModalOpen: boolean;
  automationProgressModalAutomationId: string;
  automationProgressModalAutomationName: string;
  automationProgressModalCurrentMilestone: string;
  automationProgressModalProgress: number;
  automationProgressModalMilestones: AutomationRunMilestone[];
  automationProgressModalElapsedTime: string;
  automationProgressModalConflicts: number;
  automationProgressModalStatus: "running" | "complete" | "failed" | "cancelled";
  automationProgressModalSessionId: string;
  // Automation run history state
  automationRunHistoryLoading: boolean;
  automationRunHistoryRecords: AutomationRunRecord[];
  automationRunHistoryExpandedRows: Set<string>;
  automationRunHistoryCurrentPage: number;
  automationRunHistoryStatusFilter: "all" | "success" | "failed" | "running";
  automationRunHistoryDateFrom: string;
  automationRunHistoryDateTo: string;
  automationRunHistoryItemsPerPage: number;
  automationRunHistoryError: string | null;
  automationRunHistoryAutomationId: string | null;
  // Exec approval extended state
  execApprovalShowAdvanced: boolean;
  execApprovalHistory: ExecApprovalHistoryEntry[];
  execApprovalHistoryOpen: boolean;
  toggleExecApprovalHistory: (() => void) | null;
  toggleExecApprovalAdvanced: (() => void) | null;
  extendExecApprovalTimeout: (() => void) | null;
  clearExecApprovalHistory: (() => void) | null;
  // Goal management handlers
  handleOverseerPauseGoal: (goalId: string) => void;
  handleOverseerResumeGoal: (goalId: string) => void;
  handleOverseerOpenCreateGoal: () => void;
  handleOverseerCloseCreateGoal: () => void;
  handleOverseerCreateGoal: (params: {
    title: string;
    problemStatement: string;
    successCriteria: string[];
    constraints: string[];
    priority: "low" | "normal" | "high" | "urgent";
    generatePlan: boolean;
  }) => void;
  handleOverseerUpdateCreateGoalForm: (updates: Record<string, unknown>) => void;
  handleOverseerMarkWorkDone: (goalId: string, workNodeId: string, summary?: string) => void;
  handleOverseerBlockWork: (goalId: string, workNodeId: string, reason: string) => void;
  handleOverseerRetryAssignment: (goalId: string, workNodeId: string) => void;
  handleOverseerActivityFilterChange: (status: string | null) => void;
  handleOverseerActivityLimitChange: (limit: number) => void;
  // Command palette state
  commandPaletteOpen: boolean;
  commandPaletteQuery: string;
  commandPaletteSelectedIndex: number;
  /** Incremented to force re-render when favorites change. */
  commandPaletteFavVersion: number;
  commandPaletteCategory: string;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  setCommandPaletteQuery: (query: string) => void;
  setCommandPaletteSelectedIndex: (index: number) => void;
  bumpCommandPaletteFavVersion: () => void;
  setCommandPaletteCategory: (category: string) => void;
  sidebarOpen: boolean;
  sidebarContent: string | null;
  sidebarError: string | null;
  splitRatio: number;
  // Task sidebar state
  taskSidebarOpen: boolean;
  chatTasks: ChatTask[];
  chatActivityLog: ChatActivityLog[];
  taskSidebarExpandedIds: Set<string>;
  // Voice dropdown state (compose toolbar)
  voiceDropdownOpen: boolean;
  client: GatewayBrowserClient | null;
  connect: () => void;
  setTab: (tab: Tab) => void;
  setTheme: (theme: ThemeMode, context?: ThemeTransitionContext) => void;
  applySettings: (next: UiSettings) => void;
  loadOverview: () => Promise<void>;
  loadAssistantIdentity: () => Promise<void>;
  loadCron: () => Promise<void>;
  handleWhatsAppStart: (force: boolean) => Promise<void>;
  handleWhatsAppWait: () => Promise<void>;
  handleWhatsAppLogout: () => Promise<void>;
  handleChannelConfigSave: () => Promise<void>;
  handleChannelConfigReload: () => Promise<void>;
  handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  handleNostrProfileCancel: () => void;
  handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  handleNostrProfileSave: () => Promise<void>;
  handleNostrProfileImport: () => Promise<void>;
  handleNostrProfileToggleAdvanced: () => void;
  handleChannelWizardOpen: (channelId: string) => void;
  handleChannelWizardClose: () => void;
  handleChannelWizardSave: () => Promise<void>;
  handleChannelWizardDiscard: () => void;
  handleChannelWizardSectionChange: (sectionId: string) => void;
  handleChannelWizardConfirmClose: () => void;
  handleChannelWizardCancelClose: () => void;
  handleExecApprovalDecision: (decision: "allow-once" | "allow-session" | "allow-always" | "deny" | "deny-always") => Promise<void>;
  handleOverseerRefresh: () => Promise<void>;
  handleOverseerTick: () => Promise<void>;
  handleOverseerSelectGoal: (goalId: string | null) => Promise<void>;
  handleOverseerSelectOverseerNode: (nodeId: string | null) => void;
  handleOverseerSelectSystemNode: (nodeId: string | null) => void;
  handleOverseerViewportChange: (kind: "overseer" | "system", next: GraphViewport) => void;
  handleOverseerDragChange: (kind: "overseer" | "system", next: GraphDragState | null) => void;
  handleOverseerToggleGraph: (kind: "overseer" | "system", next: boolean) => void;
  handleOverseerDrawerClose: () => void;
  handleOverseerLoadCronRuns: (jobId: string) => Promise<void>;
  handleSessionsDrawerClose: () => void;
  handleSessionsDrawerToggleExpanded: () => void;
  handleSessionsDrawerOpen: (key: string) => Promise<void>;
  handleSessionsDrawerOpenExpanded: (key: string) => Promise<void>;
  handleSessionsDrawerRefreshPreview: () => Promise<void>;
  handleChatScroll: (event: Event) => void;
  handleSendChat: (message?: string, opts?: { restoreDraft?: boolean }) => Promise<void>;
  handleAbortChat: () => Promise<void>;
  handleToggleAudioRecording: () => void;
  handleReadAloudToggle: (text?: string | null) => void;
  handleTtsProviderChange: (provider: TtsProviderId) => void;
  removeQueuedMessage: (id: string) => void;
  handleLogsToggleSidebar: () => void;
  handleLogsToggleFilters: () => void;
  handleLogsSubsystemToggle: (subsystem: string) => void;
  handleLogsScroll: (event: Event) => void;
  exportLogs: (lines: string[], label: string) => void;
  clearLogs: () => void;
  jumpToLogsBottom: () => void;
  handleOpenSidebar: (content: string) => void;
  handleCloseSidebar: () => void;
  handleSplitRatioChange: (ratio: number) => void;
  resetToolStream: () => void;
  resetChatScroll: () => void;
  // Task sidebar handlers
  handleOpenTaskSidebar: () => void;
  handleCloseTaskSidebar: () => void;
  handleToggleTaskExpanded: (taskId: string) => void;
  syncTasksFromToolStream: () => void;
  // Persistence helpers for UI state
  persistLogsPreset: (preset: "errors-only" | "warnings" | "debug" | "verbose" | "custom") => void;
  persistSessionsPreset: (preset: "all" | "active" | "errored" | "cron" | "custom") => void;
  persistOverviewShowSystemMetrics: (show: boolean) => void;
  persistConfigShowQuickSetup: (show: boolean) => void;
  persistNavShowAdvanced: (show: boolean) => void;
  persistSessionsShowAdvancedFilters: (show: boolean) => void;
};
