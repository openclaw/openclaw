/**
 * OpenClaw 应用主组件
 * 
 * 本文件是 OpenClaw 控制面板应用的主组件，集成了聊天、设置、渠道配置、
 * 会话管理、cron 任务等所有功能模块。
 */

// 导入 LitElement 基础类
import { LitElement } from "lit";
// 导入装饰器
import { customElement, state } from "lit/decorators.js";
// 导入 i18n 相关
import { i18n, I18nController, isSupportedLocale } from "../i18n/index.ts";
// 导入渠道配置处理函数
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
} from "./app-channels.ts";
// 导入聊天处理函数
import {
  handleAbortChat as handleAbortChatInternal,
  handleChatDraftChange as handleChatDraftChangeInternal,
  handleChatInputHistoryKey as handleChatInputHistoryKeyInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  resetChatInputHistoryNavigation as resetChatInputHistoryNavigationInternal,
  steerQueuedChatMessage as steerQueuedChatMessageInternal,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./app-chat.ts";
// 导入默认值
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults.ts";
// 导入事件日志类型
import type { EventLogEntry } from "./app-events.ts";
// 导入 Gateway 连接函数
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
// 导入生命周期处理函数
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
// 导入渲染函数
import { renderApp } from "./app-render.ts";
// 导入滚动处理函数
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
// 导入设置处理函数
import {
  applySettings as applySettingsInternal,
  applyLocalUserIdentity as applyLocalUserIdentityInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  setThemeMode as setThemeModeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
// 导入工具流类型和函数
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
// 导入视图状态类型
import type { AppViewState } from "./app-view-state.ts";
// 导入助手身份规范化函数
import { normalizeAssistantIdentity } from "./assistant-identity.ts";
// 导入聊天导出函数
import { exportChatMarkdown } from "./chat/export.ts";
// 导入实时对话会话类型
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./chat/realtime-talk.ts";
// 导入聊天侧边结果类型
import type { ChatSideResult } from "./chat/side-result.ts";
// 导入代理工具加载函数
import {
  loadToolsEffective as loadToolsEffectiveInternal,
  refreshVisibleToolsEffectiveForCurrentSession as refreshVisibleToolsEffectiveForCurrentSessionInternal,
} from "./controllers/agents.ts";
// 导入助手身份加载函数
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
// 导入设备配对列表类型
import type { DevicePairingList } from "./controllers/devices.ts";
// 导入做梦状态相关类型
import type {
  DreamingStatus,
  WikiImportInsights,
  WikiMemoryPalace,
} from "./controllers/dreaming.ts";
// 导入执行审批请求类型
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
// 导入执行审批文件类型
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
// 导入技能搜索结果类型
import type {
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
// 导入自定义主题导入函数
import { importCustomThemeFromUrl } from "./custom-theme.ts";
// 导入 Gateway 类型
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
// 导入标签页类型
import type { Tab } from "./navigation.ts";
// 导入解析代理 ID 函数
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
// 导入侧边栏内容类型
import type { SidebarContent } from "./sidebar-content.ts";
// 导入本地用户身份加载函数和设置加载函数
import { loadLocalUserIdentity, loadSettings, type UiSettings } from "./storage.ts";
// 导入主题相关类型和常量
import { VALID_THEME_NAMES, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
// 导入各种结果类型
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  ChatModelOverride,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSummary,
  LogEntry,
  LogLevel,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionCompactionCheckpoint,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "./types.ts";
// 导入 UI 类型
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types.ts";
// 导入 UUID 生成函数
import { generateUUID } from "./uuid.ts";
// 导入 Nostr Profile 表单状态类型
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

// ============ 全局声明 ============

// 声明全局窗口对象的类型扩展
declare global {
  interface Window {
    // 控制面板基础路径（可选）
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

// ============ 引导状态初始化 ============

// 规范化引导助手身份
const bootAssistantIdentity = normalizeAssistantIdentity({});
// 加载本地用户身份
const bootLocalUserIdentity = loadLocalUserIdentity();

/**
 * 解析引导模式
 * 通过 URL 参数 onboarding=1|true|yes|on 启用
 * @returns 是否应该显示引导界面
 */
function resolveOnboardingMode(): boolean {
  // 如果没有 URL 参数，返回 false
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  // 规范化参数值并检查是否为真
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// ============ 主应用组件类 ============

/**
 * OpenClaw 主应用组件
 * 使用 LitElement 构建，封装所有应用状态和逻辑
 */
@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  // i18n 控制器
  private i18nController = new I18nController(this);
  // 客户端实例 ID
  clientInstanceId = generateUUID();
  // 连接代数
  connectGeneration = 0;
  // 应用设置状态
  @state() settings: UiSettings = loadSettings();

  /**
   * 构造函数
   */
  constructor() {
    super();
    // 如果支持所选语言环境，设置它
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    }
  }

  // ============ 密码和登录状态 ============
  @state() password = "";
  @state() loginShowGatewayToken = false;
  @state() loginShowGatewayPassword = false;

  // ============ 标签页和主题状态 ============
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() themeMode: ThemeMode = this.settings.themeMode ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() themeOrder: ThemeName[] = this.buildThemeOrder(this.theme);

  // ============ 自定义主题状态 ============
  @state() customThemeImportUrl = "";
  @state() customThemeImportBusy = false;
  @state() customThemeImportMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() customThemeImportExpanded = false;
  @state() customThemeImportFocusToken = 0;
  private customThemeImportSelectOnSuccess = false;

  // ============ Gateway 状态 ============
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;

  // ============ 事件日志状态 ============
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  // ============ 助手身份状态 ============
  @state() assistantName = bootAssistantIdentity.name;
  @state() assistantAvatar = bootAssistantIdentity.avatar;
  @state() assistantAvatarSource = bootAssistantIdentity.avatarSource ?? null;
  @state() assistantAvatarStatus = bootAssistantIdentity.avatarStatus ?? null;
  @state() assistantAvatarReason = bootAssistantIdentity.avatarReason ?? null;
  @state() assistantAvatarUploadBusy = false;
  @state() assistantAvatarUploadError: string | null = null;
  @state() assistantAgentId = bootAssistantIdentity.agentId ?? null;

  // ============ 用户身份状态 ============
  @state() userName = bootLocalUserIdentity.name;
  @state() userAvatar = bootLocalUserIdentity.avatar;
  @state() localMediaPreviewRoots: string[] = [];

  // ============ 安全设置状态 ============
  @state() embedSandboxMode: "strict" | "scripts" | "trusted" = "scripts";
  @state() allowExternalEmbedUrls = false;

  // ============ 服务器状态 ============
  @state() serverVersion: string | null = null;

  // ============ 会话和聊天状态 ============
  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStreamSegments: Array<{ text: string; ts: number }> = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatSideResult: ChatSideResult | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() fallbackStatus: FallbackStatus | null = null;

  // ============ 聊天头像状态 ============
  @state() chatAvatarUrl: string | null = null;
  @state() chatAvatarSource: string | null = null;
  @state() chatAvatarStatus: "none" | "local" | "remote" | "data" | null = null;
  @state() chatAvatarReason: string | null = null;
  @state() chatThinkingLevel: string | null = null;

  // ============ 聊天模型状态 ============
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];

  // ============ 聊天队列和附件状态 ============
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];

  // ============ 实时对话状态 ============
  @state() realtimeTalkActive = false;
  @state() realtimeTalkStatus: RealtimeTalkStatus = "idle";
  @state() realtimeTalkDetail: string | null = null;
  @state() realtimeTalkTranscript: string | null = null;
  private realtimeTalkSession: RealtimeTalkSession | null = null;

  // ============ UI 状态 ============
  @state() chatManualRefreshInFlight = false;
  @state() navDrawerOpen = false;

  // ============ 斜杠命令和历史状态 ============
  onSlashAction?: (action: string) => void;
  chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>> = {};
  chatInputHistorySessionKey: string | null = null;
  chatInputHistoryItems: string[] | null = null;
  @state() chatInputHistoryIndex = -1;
  chatDraftBeforeHistory: string | null = null;

  // ============ 侧边栏状态（用于工具输出查看） ============
  @state() sidebarOpen = false;
  @state() sidebarContent: SidebarContent | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  // ============ 节点和设备状态 ============
  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;

  // ============ 执行审批状态 ============
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

  // ============ Gateway URL 状态 ============
  @state() pendingGatewayUrl: string | null = null;
  pendingGatewayToken: string | null = null;

  // ============ 配置状态 ============
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
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;

  // ============ 做梦状态 ============
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
  @state() dreamingRestartConfirmOpen = false;
  @state() dreamingRestartConfirmLoading = false;
  @state() dreamingPendingEnabled: boolean | null = null;
  @state() dreamDiaryLoading = false;
  @state() dreamDiaryActionLoading = false;
  @state() dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() dreamDiaryActionArchivePath: string | null = null;
  @state() dreamDiaryError: string | null = null;
  @state() dreamDiaryPath: string | null = null;
  @state() dreamDiaryContent: string | null = null;
  @state() wikiImportInsightsLoading = false;
  @state() wikiImportInsightsError: string | null = null;
  @state() wikiImportInsights: WikiImportInsights | null = null;
  @state() wikiMemoryPalaceLoading = false;
  @state() wikiMemoryPalaceError: string | null = null;
  @state() wikiMemoryPalace: WikiMemoryPalace | null = null;

  // ============ 配置表单状态 ============
  @state() configFormDirty = false;
  @state() configSettingsMode: "quick" | "advanced" = "quick";
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  @state() pendingUpdateExpectedVersion: string | null = null;
  @state() updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null = null;

  // ============ 各区域表单状态 ============
  @state() communicationsFormMode: "form" | "raw" = "form";
  @state() communicationsSearchQuery = "";
  @state() communicationsActiveSection: string | null = null;
  @state() communicationsActiveSubsection: string | null = null;
  @state() appearanceFormMode: "form" | "raw" = "form";
  @state() appearanceSearchQuery = "";
  @state() appearanceActiveSection: string | null = null;
  @state() appearanceActiveSubsection: string | null = null;
  @state() automationFormMode: "form" | "raw" = "form";
  @state() automationSearchQuery = "";
  @state() automationActiveSection: string | null = null;
  @state() automationActiveSubsection: string | null = null;
  @state() infrastructureFormMode: "form" | "raw" = "form";
  @state() infrastructureSearchQuery = "";
  @state() infrastructureActiveSection: string | null = null;
  @state() infrastructureActiveSubsection: string | null = null;
  @state() aiAgentsFormMode: "form" | "raw" = "form";
  @state() aiAgentsSearchQuery = "";
  @state() aiAgentsActiveSection: string | null = null;
  @state() aiAgentsActiveSubsection: string | null = null;

  // ============ 渠道状态 ============
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

  // ============ 在线状态 ============
  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  // ============ 代理状态 ============
  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;

  // ============ 工具目录状态 ============
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;

  // ============ 代理面板状态 ============
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" = "files";

  // ============ 代理文件状态 ============
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;

  // ============ 代理身份状态 ============
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};

  // ============ 代理技能状态 ============
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  // ============ 会话列表状态 ============
  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsHideCron = true;
  @state() sessionsSearchQuery = "";
  @state() sessionsSortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() sessionsSortDir: "asc" | "desc" = "desc";
  @state() sessionsPage = 0;
  @state() sessionsPageSize = 25;
  @state() sessionsSelectedKeys: Set<string> = new Set();
  @state() sessionsExpandedCheckpointKey: string | null = null;
  @state() sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() sessionsCheckpointLoadingKey: string | null = null;
  @state() sessionsCheckpointBusyKey: string | null = null;
  @state() sessionsCheckpointErrorByKey: Record<string, string> = {};

  // ============ 使用量状态 ============
  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  // 使用量日期范围（默认为当天）
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageTimeSeriesCursorStart: number | null = null;
  @state() usageTimeSeriesCursorEnd: number | null = null;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // 已应用的查询（用于客户端过滤已加载的会话列表）
  @state() usageQuery = "";
  // 草稿查询文本（用户输入时立即更新；通过防抖或"搜索"应用）
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // 非响应式定时器（不因定时器 bookkeeping 触发渲染）
  usageQueryDebounceTimer: number | null = null;

  // ============ Cron 状态 ============
  @state() cronLoading = false;
  @state() cronQuickCreateOpen = false;
  @state() cronQuickCreateStep: import("./views/cron-quick-create.ts").CronQuickCreateStep = "what";
  @state() cronQuickCreateDraft:
    | import("./views/cron-quick-create.ts").CronQuickCreateDraft
    | null = null;
  @state() cronJobsLoadingMore = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronJobsTotal = 0;
  @state() cronJobsHasMore = false;
  @state() cronJobsNextOffset: number | null = null;
  @state() cronJobsLimit = 50;
  @state() cronJobsQuery = "";
  @state() cronJobsEnabledFilter: import("./types.js").CronJobsEnabledFilter = "all";
  @state() cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter =
    "all";
  @state() cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter =
    "all";
  @state() cronJobsSortBy: import("./types.js").CronJobsSortBy = "nextRunAtMs";
  @state() cronJobsSortDir: import("./types.js").CronSortDir = "asc";
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() cronEditingJobId: string | null = null;
  @state() cronRunsJobId: string | null = null;
  @state() cronRunsLoadingMore = false;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronRunsTotal = 0;
  @state() cronRunsHasMore = false;
  @state() cronRunsNextOffset: number | null = null;
  @state() cronRunsLimit = 50;
  @state() cronRunsScope: import("./types.js").CronRunScope = "all";
  @state() cronRunsStatuses: import("./types.js").CronRunsStatusValue[] = [];
  @state() cronRunsDeliveryStatuses: import("./types.js").CronDeliveryStatus[] = [];
  @state() cronRunsStatusFilter: import("./types.js").CronRunsStatusFilter = "all";
  @state() cronRunsQuery = "";
  @state() cronRunsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronModelSuggestions: string[] = [];
  @state() cronBusy = false;

  // ============ 更新状态 ============
  @state() updateAvailable: import("./types.js").UpdateAvailable | null = null;

  // ============ 概览仪表板状态 ============
  @state() attentionItems: import("./types.js").AttentionItem[] = [];
  @state() paletteOpen = false;
  @state() paletteQuery = "";
  @state() paletteActiveIndex = 0;
  @state() overviewShowGatewayToken = false;
  @state() overviewShowGatewayPassword = false;
  @state() overviewLogLines: string[] = [];
  @state() overviewLogCursor = 0;

  // ============ 技能状态 ============
  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled" = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() skillsDetailKey: string | null = null;
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallSlug: string | null = null;
  @state() clawhubInstallMessage: { kind: "success" | "error"; text: string } | null = null;

  // ============ 健康检查状态 ============
  @state() healthLoading = false;
  @state() healthResult: HealthSummary | null = null;
  @state() healthError: string | null = null;

  // ============ 模型认证状态 ============
  @state() modelAuthStatusLoading = false;
  @state() modelAuthStatusResult: ModelAuthStatusResult | null = null;
  @state() modelAuthStatusError: string | null = null;

  // ============ 调试状态 ============
  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSummary | null = null;
  @state() debugModels: ModelCatalogEntry[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  // ============ Web 推送状态 ============
  @state() webPushSupported = false;
  @state() webPushPermission: NotificationPermission | "unsupported" = "unsupported";
  @state() webPushSubscribed = false;
  @state() webPushLoading = false;

  // ============ 日志状态 ============
  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  // ============ 私有实例变量 ============
  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  @state() chatNewMessagesBelow = false;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Set<string>();
  chatSideResultTerminalRuns = new Set<string>();
  basePath = "";

  // 浏览器历史popstate处理器
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);

  // 顶部栏大小观察器
  private topbarObserver: ResizeObserver | null = null;

  // 全局键盘事件处理器（用于快捷键）
  private globalKeydownHandler = (e: KeyboardEvent) => {
    // 检测 Ctrl/Cmd + K 快捷键，打开命令面板
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      this.paletteOpen = !this.paletteOpen;
      if (this.paletteOpen) {
        this.paletteQuery = "";
        this.paletteActiveIndex = 0;
      }
    }
  };

  // ============ 生命周期方法 ============

  /**
   * 创建渲染根元素
   * 返回自身作为渲染根，不使用 Shadow DOM
   */
  createRenderRoot() {
    return this;
  }

  /**
   * 连接回调
   * 组件首次连接到 DOM 时调用
   */
  connectedCallback() {
    super.connectedCallback();
    // 设置斜杠命令动作处理器
    this.onSlashAction = (action: string) => {
      switch (action) {
        case "toggle-focus":
          // 切换专注模式
          this.applySettings({
            ...this.settings,
            chatFocusMode: !this.settings.chatFocusMode,
          });
          break;
        case "export":
          // 导出聊天为 Markdown
          exportChatMarkdown(this.chatMessages, this.assistantName);
          break;
        case "refresh-tools-effective": {
          // 刷新当前会话的有效工具
          void refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
          break;
        }
      }
    };
    // 添加全局键盘事件监听器
    document.addEventListener("keydown", this.globalKeydownHandler);
    // 处理连接
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
    // 初始化 Web 推送状态
    void this.initWebPushState();
  }

  /**
   * 首次更新回调
   */
  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  /**
   * 断开连接回调
   * 组件从 DOM 断开时调用
   */
  disconnectedCallback() {
    // 移除全局键盘事件监听器
    document.removeEventListener("keydown", this.globalKeydownHandler);
    // 处理断开连接
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  /**
   * 更新回调
   * 组件属性变化时调用
   */
  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    // 如果 sessionKey 未变化或不在工具面板，不处理
    if (!changed.has("sessionKey") || this.agentsPanel !== "tools") {
      return;
    }
    // 获取当前会话的代理 ID
    const activeSessionAgentId = resolveAgentIdFromSessionKey(this.sessionKey);
    // 如果选中的代理 ID 与会话代理 ID 相同，加载工具
    if (this.agentsSelectedId && this.agentsSelectedId === activeSessionAgentId) {
      void loadToolsEffectiveInternal(this, {
        agentId: this.agentsSelectedId,
        sessionKey: this.sessionKey,
      });
      return;
    }
    // 重置工具相关状态
    this.toolsEffectiveResult = null;
    this.toolsEffectiveResultKey = null;
    this.toolsEffectiveError = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
  }

  // ============ 连接方法 ============

  /**
   * 连接到 Gateway
   */
  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  // ============ 滚动处理方法 ============

  /**
   * 处理聊天滚动事件
   */
  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  /**
   * 处理日志滚动事件
   */
  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  /**
   * 导出日志
   */
  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  /**
   * 重置工具流
   */
  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  /**
   * 重置聊天滚动
   */
  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  /**
   * 滚动到底部
   * @param opts - 选项
   */
  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  // ============ 异步加载方法 ============

  /**
   * 加载助手身份
   */
  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  // ============ 设置方法 ============

  /**
   * 应用设置
   */
  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  /**
   * 应用本地用户身份
   */
  applyLocalUserIdentity(next: { name?: string | null; avatar?: string | null }) {
    applyLocalUserIdentityInternal(
      this as unknown as Parameters<typeof applyLocalUserIdentityInternal>[0],
      next,
    );
  }

  /**
   * 设置标签页
   */
  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
    this.navDrawerOpen = false;
  }

  /**
   * 设置主题
   */
  setTheme(next: ThemeName, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
    this.themeOrder = this.buildThemeOrder(next);
  }

  /**
   * 设置主题模式
   */
  setThemeMode(next: ThemeMode, context?: Parameters<typeof setThemeModeInternal>[2]) {
    setThemeModeInternal(
      this as unknown as Parameters<typeof setThemeModeInternal>[0],
      next,
      context,
    );
  }

  /**
   * 设置自定义主题导入 URL
   */
  setCustomThemeImportUrl(next: string) {
    this.customThemeImportUrl = next;
    // 清除之前的错误消息
    if (this.customThemeImportMessage?.kind === "error") {
      this.customThemeImportMessage = null;
    }
  }

  /**
   * 打开自定义主题导入
   */
  openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
    // 如果当前没有自定义主题，选择导入的主题
    if (!this.settings.customTheme) {
      this.customThemeImportSelectOnSuccess = true;
    }
  }

  /**
   * 导入自定义主题
   */
  async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      // 从 URL 导入主题
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      // 判断是否应该选择导入的主题
      const shouldSelectImportedTheme =
        this.theme === "custom" ||
        !this.settings.customTheme ||
        this.customThemeImportSelectOnSuccess;
      // 应用设置
      applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
        ...this.settings,
        theme: shouldSelectImportedTheme ? "custom" : this.settings.theme,
        customTheme,
      });
      // 更新主题顺序
      this.themeOrder = this.buildThemeOrder(shouldSelectImportedTheme ? "custom" : this.theme);
      // 重置导入 URL
      this.customThemeImportUrl = "";
      this.customThemeImportSelectOnSuccess = false;
      this.customThemeImportMessage = {
        kind: "success",
        text: `Imported ${customTheme.label}.`,
      };
    } catch (error) {
      this.customThemeImportMessage = {
        kind: "error",
        text: error instanceof Error ? error.message : "Failed to import tweakcn theme.",
      };
    } finally {
      this.customThemeImportBusy = false;
    }
  }

  /**
   * 清除自定义主题
   */
  clearCustomTheme() {
    const nextTheme = this.theme === "custom" ? "claw" : this.theme;
    this.customThemeImportExpanded = true;
    this.customThemeImportSelectOnSuccess = false;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      theme: nextTheme,
      customTheme: undefined,
    });
    this.themeOrder = this.buildThemeOrder(nextTheme);
    this.customThemeImportMessage = {
      kind: "success",
      text: "Cleared custom theme.",
    };
  }

  /**
   * 设置边框圆角
   */
  setBorderRadius(value: number) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      borderRadius: value,
    });
    this.requestUpdate();
  }

  /**
   * 构建主题顺序
   */
  buildThemeOrder(active: ThemeName): ThemeName[] {
    const all = [...VALID_THEME_NAMES];
    const rest = all.filter((id) => id !== active);
    return [active, ...rest];
  }

  /**
   * 加载概览
   */
  async loadOverview(opts?: { refresh?: boolean }) {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0], opts);
  }

  /**
   * 加载 Cron 任务
   */
  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  // ============ 聊天处理方法 ============

  /**
   * 处理中止聊天
   */
  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  /**
   * 处理聊天草稿变化
   */
  handleChatDraftChange(next: string) {
    handleChatDraftChangeInternal(
      this as unknown as Parameters<typeof handleChatDraftChangeInternal>[0],
      next,
    );
  }

  /**
   * 处理聊天输入历史键
   */
  handleChatInputHistoryKey(input: ChatInputHistoryKeyInput): ChatInputHistoryKeyResult {
    return handleChatInputHistoryKeyInternal(
      this as unknown as Parameters<typeof handleChatInputHistoryKeyInternal>[0],
      input,
    );
  }

  /**
   * 重置聊天输入历史导航
   */
  resetChatInputHistoryNavigation() {
    resetChatInputHistoryNavigationInternal(
      this as unknown as Parameters<typeof resetChatInputHistoryNavigationInternal>[0],
    );
  }

  /**
   * 移除排队消息
   */
  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  /**
   * 处理发送聊天
   */
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

  /**
   * 切换实时对话
   */
  async toggleRealtimeTalk() {
    // 如果已有会话，停止它
    if (this.realtimeTalkSession) {
      this.realtimeTalkSession.stop();
      this.realtimeTalkSession = null;
      this.realtimeTalkActive = false;
      this.realtimeTalkStatus = "idle";
      this.realtimeTalkDetail = null;
      this.realtimeTalkTranscript = null;
      return;
    }
    // 如果未连接，显示错误
    if (!this.client || !this.connected) {
      this.lastError = "Gateway not connected";
      return;
    }
    // 创建新会话
    this.realtimeTalkActive = true;
    this.realtimeTalkStatus = "connecting";
    this.realtimeTalkDetail = null;
    this.realtimeTalkTranscript = null;
    const session = new RealtimeTalkSession(this.client, this.sessionKey, {
      onStatus: (status, detail) => {
        this.realtimeTalkStatus = status;
        this.realtimeTalkDetail = detail ?? null;
        if (status === "idle" || status === "error") {
          this.realtimeTalkActive = status !== "idle";
        }
      },
      onTranscript: (entry) => {
        this.realtimeTalkTranscript = `${entry.role === "user" ? "You" : "OpenClaw"}: ${entry.text}`;
      },
    });
    this.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      if (this.realtimeTalkSession === session) {
        this.realtimeTalkSession = null;
      }
      this.realtimeTalkActive = false;
      this.realtimeTalkStatus = "error";
      this.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      this.lastError = this.realtimeTalkDetail;
    }
  }

  /**
   * 处理转向排队消息
   */
  async steerQueuedChatMessage(id: string) {
    await steerQueuedChatMessageInternal(
      this as unknown as Parameters<typeof steerQueuedChatMessageInternal>[0],
      id,
    );
  }

  // ============ 渠道处理方法 ============

  /**
   * 处理 WhatsApp 开始
   */
  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  /**
   * 处理 WhatsApp 等待
   */
  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  /**
   * 处理 WhatsApp 登出
   */
  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  /**
   * 处理渠道配置保存
   */
  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  /**
   * 处理渠道配置重新加载
   */
  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  /**
   * 处理 Nostr Profile 编辑
   */
  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  /**
   * 处理 Nostr Profile 取消
   */
  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  /**
   * 处理 Nostr Profile 字段变化
   */
  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  /**
   * 处理 Nostr Profile 保存
   */
  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  /**
   * 处理 Nostr Profile 导入
   */
  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  /**
   * 处理 Nostr Profile 切换高级模式
   */
  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  // ============ 执行审批处理方法 ============

  /**
   * 处理执行审批决定
   */
  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    // 如果没有待处理审批或未连接，不处理
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      // 根据类型选择方法
      const method = active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
      await this.client.request(method, {
        id: active.id,
        decision,
      });
      // 从队列中移除
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  // ============ Gateway URL 处理方法 ============

  /**
   * 处理 Gateway URL 确认
   */
  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() || "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    // 应用设置并连接
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      token: nextToken,
    });
    this.connect();
  }

  /**
   * 处理 Gateway URL 取消
   */
  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
  }

  // ============ 侧边栏处理方法 ============

  /**
   * 打开侧边栏
   */
  handleOpenSidebar(content: SidebarContent) {
    // 清除之前的关闭定时器
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  /**
   * 关闭侧边栏
   */
  handleCloseSidebar() {
    this.sidebarOpen = false;
    // 过渡动画后清除内容
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  /**
   * 处理分割比例变化
   */
  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  // ============ Web 推送方法 ============

  /**
   * 初始化 Web 推送状态
   */
  private async initWebPushState() {
    // 检测浏览器支持情况
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    this.webPushSupported = supported;
    this.webPushPermission = supported ? Notification.permission : "unsupported";
    if (supported) {
      try {
        const { getExistingSubscription } = await import("./push-subscription.ts");
        const existing = await getExistingSubscription();
        this.webPushSubscribed = existing !== null;
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 重置 Web 推送状态
   * 连接后重新注册本地推送订阅
   */
  async reconcileWebPushState() {
    if (!this.client) {
      return;
    }
    try {
      // 直接检查 PushManager，因为 initWebPushState 可能未完成
      const { getExistingSubscription } = await import("./push-subscription.ts");
      const existing = await getExistingSubscription();
      if (!existing) {
        return;
      }
      this.webPushSubscribed = true;
      const subJson = existing.toJSON();
      // 如果有必要的密钥，订阅
      if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
        await this.client.request("push.web.subscribe", {
          endpoint: subJson.endpoint,
          keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
        });
      }
    } catch {
      // 尽力而为，不阻塞
    }
  }

  /**
   * 处理 Web 推送订阅
   */
  async handleWebPushSubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { subscribeToWebPush } = await import("./push-subscription.ts");
      await subscribeToWebPush(this.client);
      this.webPushSubscribed = true;
      this.webPushPermission = Notification.permission;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
      // 始终刷新权限状态
      if ("Notification" in window) {
        this.webPushPermission = Notification.permission;
      }
    }
  }

  /**
   * 处理 Web 推送取消订阅
   */
  async handleWebPushUnsubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { unsubscribeFromWebPush } = await import("./push-subscription.ts");
      await unsubscribeFromWebPush(this.client);
      this.webPushSubscribed = false;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
    }
  }

  /**
   * 处理 Web 推送测试
   */
  async handleWebPushTest() {
    if (!this.client) {
      return;
    }
    try {
      const { sendTestWebPush } = await import("./push-subscription.ts");
      await sendTestWebPush(this.client);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  // ============ 渲染方法 ============

  /**
   * 渲染应用
   */
  render() {
    return renderApp(this as unknown as AppViewState);
  }
}
