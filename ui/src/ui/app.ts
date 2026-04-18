import { LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { i18n, I18nController, isSupportedLocale } from "../i18n/index.ts";
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
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  steerQueuedChatMessage as steerQueuedChatMessageInternal,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults.ts";
import type { EventLogEntry } from "./app-events.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
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
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
import type { AppViewState } from "./app-view-state.ts";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";
import { exportChatMarkdown } from "./chat/export.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./chat/realtime-talk.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import {
  loadToolsEffective as loadToolsEffectiveInternal,
  refreshVisibleToolsEffectiveForCurrentSession as refreshVisibleToolsEffectiveForCurrentSessionInternal,
} from "./controllers/agents.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type {
  DreamingStatus,
  WikiImportInsights,
  WikiMemoryPalace,
} from "./controllers/dreaming.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillMessage,
} from "./controllers/skills.ts";
import { importCustomThemeFromUrl } from "./custom-theme.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import type { SidebarContent } from "./sidebar-content.ts";
import { loadLocalUserIdentity, loadSettings, type UiSettings } from "./storage.ts";
import { VALID_THEME_NAMES, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
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
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const bootAssistantIdentity = normalizeAssistantIdentity({});
const bootLocalUserIdentity = loadLocalUserIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Build the synthetic user-turn message sent to the agent after the
 * user resolves a plan-approval card. The agent sees this as a normal
 * user message with a structured tag at the top so it knows the plan
 * lifecycle outcome.
 *
 * - approve: agent should execute the plan as-proposed.
 * - edit: agent has license to make minor edits during execution.
 * - reject: agent stays in plan mode and revises (the runtime keeps
 *   planMode armed; rejection feedback is in the message body).
 */
function buildPlanDecisionUserMessage(
  decision: "approve" | "reject" | "edit",
  summary: string | null,
  feedback: string | null,
): string {
  const trimmedSummary = summary?.trim();
  const summaryClause = trimmedSummary ? ` (${trimmedSummary})` : "";
  switch (decision) {
    case "approve":
      return [
        `[PLAN_DECISION] decision: approved${summaryClause}`,
        "",
        "The plan you proposed via exit_plan_mode is approved. Plan mode is OFF and mutating tools (write, edit, exec, bash, apply_patch) are unlocked.",
        "",
        "Begin executing now and continue through EVERY step in the plan without stopping for status updates between steps. Use update_plan to mark each step in_progress / completed as you go — that's the user-visible progress signal, not chat-text checkpoints.",
        "",
        "Only stop when ONE of these is true:",
        "- the plan is complete (all steps marked completed or cancelled)",
        "- you hit a real blocker that genuinely requires user input to proceed",
        "- you would take a destructive/irreversible action (rm -rf, force-push, irreversible API call, money movement) — those still require explicit user confirmation",
        "",
        "Do NOT pause to summarize after step 1, 2, or any individual step. Do NOT respond with a 'progress so far' message between tool calls. The user can see your tool calls live.",
      ].join("\n");
    case "edit":
      return [
        `[PLAN_DECISION] decision: approved-with-edits${summaryClause}`,
        "",
        "The plan is approved with this gate for in-flight deviation:",
        "- you MAY make minor edits during execution if you are >95% confident in the change",
        "- if a deviation requires <95% confidence, use read-only tools / spawn a focused subagent to research and validate the new path until you reach 95% confidence",
        "- when you do deviate, call update_plan to record the new step before executing it",
        "",
        "Plan mode is OFF and mutating tools are unlocked. Begin executing now and continue through EVERY step without stopping for status updates between steps. Use update_plan to mark progress — that's the user-visible signal.",
        "",
        "Only stop when ONE of these is true:",
        "- the plan is complete",
        "- a real blocker requires user input",
        "- you would take a destructive/irreversible action (rm -rf, force-push, irreversible API call, money movement)",
        "",
        "Do NOT pause to summarize after step 1, 2, or any individual step. Do NOT respond with a 'progress so far' message between tool calls.",
      ].join("\n");
    case "reject":
      return [
        `[PLAN_DECISION] decision: rejected${summaryClause}`,
        "",
        feedback?.trim()
          ? `The user wants you to revise. Their feedback:\n\n${feedback.trim()}`
          : "The user rejected the plan without specific feedback — revise based on the most likely gap (more detail, different approach, smaller scope, etc.) or ask one targeted clarifying question if you genuinely can't infer.",
        "",
        "You are STILL in plan mode. Your next response MUST include an `exit_plan_mode` tool call with the revised plan steps. Do NOT just acknowledge with chat text — call the tool. Do NOT stop after a one-line 'Revising' message — that wastes a turn. The user is waiting on the revised approval card.",
      ].join("\n");
    default: {
      const _exhaustive: never = decision;
      // _exhaustive is `never` — TS catches new variants at compile
      // time. Fallback string only fires if someone bypasses typing.
      return `[PLAN_DECISION] decision: ${String(_exhaustive)}`;
    }
  }
}

/**
 * PR-8 follow-up Round 2: shared placeholder content for the plan-view
 * sidebar when no `update_plan` event has fired yet on this session.
 * Module-level so `togglePlanViewSidebar` and other consumers can do
 * an identity check (===) against the same string instance.
 */
const PLAN_VIEW_PLACEHOLDER_MARKDOWN =
  "# No active plan\n\nThe agent hasn't called `update_plan` yet on this session. Once it does, the current plan will render here and tick off live as the agent steps through.\n";

/**
 * PR-8 follow-up Round 2: build the live-plan markdown checklist from
 * a plan-step array. Shared between the live-stream path (refresh on
 * every `agent_plan_event`) and the refresh-restore path (rebuild from
 * persisted `SessionEntry.planMode.lastPlanSteps` when the page mounts).
 * Keeps both surfaces byte-identical so the toggle's identity check
 * (`sidebarContent.content === latestPlanMarkdown`) works after either.
 *
 * PR-9 Wave A2: derive "Plan complete" header automatically when every
 * step is terminal — the runtime auto-flips planMode to "normal" via
 * the gateway-side persister, and the sidebar reflects that visually
 * without the user having to compare statuses by eye.
 */
function buildPlanViewMarkdown(
  plan: ReadonlyArray<{
    step: string;
    status: string;
    activeForm?: string;
    acceptanceCriteria?: string[];
    verifiedCriteria?: string[];
  }>,
  summary?: string,
  archetype?: {
    analysis?: string;
    assumptions?: string[];
    risks?: ReadonlyArray<{ risk: string; mitigation: string }>;
    verification?: string[];
    references?: string[];
  },
): string {
  const stepLines = plan
    .map((step, i) => {
      const marker =
        step.status === "completed" ? "[x]" : step.status === "cancelled" ? "[ ] ~~" : "[ ]";
      const close = step.status === "cancelled" ? "~~" : "";
      const label = step.status === "in_progress" && step.activeForm ? step.activeForm : step.step;
      const lines = [`${i + 1}. ${marker} ${label}${close}`];
      // PR-9 Wave B1: render acceptance criteria as a nested checklist
      // beneath each step. Verified criteria render as `[x]`, unverified
      // as `[ ]`. Skipped entirely when no criteria are declared so
      // existing simple plans render unchanged.
      if (step.acceptanceCriteria && step.acceptanceCriteria.length > 0) {
        const verifiedSet = new Set(step.verifiedCriteria ?? []);
        for (const criterion of step.acceptanceCriteria) {
          const cMarker = verifiedSet.has(criterion) ? "[x]" : "[ ]";
          lines.push(`    - ${cMarker} ${criterion}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
  const allTerminal =
    plan.length > 0 && plan.every((s) => s.status === "completed" || s.status === "cancelled");
  const header = summary ?? (allTerminal ? "Plan complete \u2713" : "Active plan");
  const sections: string[] = [`# ${header}`, ""];
  // PR-10 archetype: render rich plan sections when present. Markdown
  // structure mirrors the persisted file format (title → analysis →
  // plan checklist → assumptions → risks → verification → references).
  // Sections only appear when populated so simple plans render
  // identically to today.
  if (archetype?.analysis) {
    sections.push("## Analysis", "", archetype.analysis, "");
  }
  sections.push("## Plan", "", stepLines, "");
  if (archetype?.assumptions && archetype.assumptions.length > 0) {
    sections.push("## Assumptions", "");
    for (const a of archetype.assumptions) {
      sections.push(`- ${a}`);
    }
    sections.push("");
  }
  if (archetype?.risks && archetype.risks.length > 0) {
    sections.push("## Risks", "");
    sections.push("| Risk | Mitigation |");
    sections.push("| --- | --- |");
    for (const r of archetype.risks) {
      sections.push(`| ${escapeMarkdownCell(r.risk)} | ${escapeMarkdownCell(r.mitigation)} |`);
    }
    sections.push("");
  }
  if (archetype?.verification && archetype.verification.length > 0) {
    sections.push("## Verification", "");
    for (const v of archetype.verification) {
      sections.push(`- ${v}`);
    }
    sections.push("");
  }
  if (archetype?.references && archetype.references.length > 0) {
    sections.push("## References", "");
    for (const r of archetype.references) {
      sections.push(`- ${r}`);
    }
    sections.push("");
  }
  return sections.join("\n");
}

/** PR-10: minimal cell-escape so risk/mitigation text doesn't break the markdown table. */
function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  private i18nController = new I18nController(this);
  clientInstanceId = generateUUID();
  connectGeneration = 0;
  @state() settings: UiSettings = loadSettings();
  constructor() {
    super();
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    }
  }
  @state() password = "";
  @state() loginShowGatewayToken = false;
  @state() loginShowGatewayPassword = false;
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() themeMode: ThemeMode = this.settings.themeMode ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() themeOrder: ThemeName[] = this.buildThemeOrder(this.theme);
  @state() customThemeImportUrl = "";
  @state() customThemeImportBusy = false;
  @state() customThemeImportMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() customThemeImportExpanded = false;
  @state() customThemeImportFocusToken = 0;
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = bootAssistantIdentity.name;
  @state() assistantAvatar = bootAssistantIdentity.avatar;
  @state() assistantAgentId = bootAssistantIdentity.agentId ?? null;
  @state() userName = bootLocalUserIdentity.name;
  @state() userAvatar = bootLocalUserIdentity.avatar;
  @state() localMediaPreviewRoots: string[] = [];
  @state() embedSandboxMode: "strict" | "scripts" | "trusted" = "scripts";
  @state() allowExternalEmbedUrls = false;
  @state() serverVersion: string | null = null;

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
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() realtimeTalkActive = false;
  @state() realtimeTalkStatus: RealtimeTalkStatus = "idle";
  @state() realtimeTalkDetail: string | null = null;
  @state() realtimeTalkTranscript: string | null = null;
  private realtimeTalkSession: RealtimeTalkSession | null = null;
  @state() chatManualRefreshInFlight = false;
  @state() navDrawerOpen = false;

  onSlashAction?: (action: string) => void;

  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: SidebarContent | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

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
  // PR-8 / #67721: plan approval card state — populated by handleAgentEvent
  // when the runtime emits an `approval` stream event with kind:"plugin"
  // and a plan payload.
  @state() planApprovalRequest: import("./app-tool-stream.ts").PlanApprovalRequest | null = null;
  @state() planApprovalBusy = false;
  @state() planApprovalError: string | null = null;
  // Inline-revise textarea state (no popup). Open + draft live on the
  // host so the textarea survives chat re-renders.
  @state() planApprovalReviseOpen = false;
  @state() planApprovalReviseDraft = "";
  // PR-8 follow-up: latest known plan content (rendered as markdown).
  // Updated whenever the agent calls update_plan (regardless of whether
  // the sidebar is open). The chat-controls "Plan view" button reads
  // this to render the current plan on demand and the `/plan view`
  // slash command opens the same content in the sidebar.
  @state() latestPlanMarkdown: string | null = null;
  @state() pendingGatewayUrl: string | null = null;
  pendingGatewayToken: string | null = null;

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
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
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
  @state() configFormDirty = false;
  @state() configSettingsMode: "quick" | "advanced" = "quick";
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
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

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" = "files";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

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

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
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
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
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

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

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

  @state() updateAvailable: import("./types.js").UpdateAvailable | null = null;

  // Overview dashboard state
  @state() attentionItems: import("./types.js").AttentionItem[] = [];
  @state() paletteOpen = false;
  @state() paletteQuery = "";
  @state() paletteActiveIndex = 0;
  @state() overviewShowGatewayToken = false;
  @state() overviewShowGatewayPassword = false;
  @state() overviewLogLines: string[] = [];
  @state() overviewLogCursor = 0;

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

  @state() healthLoading = false;
  @state() healthResult: HealthSummary | null = null;
  @state() healthError: string | null = null;

  @state() modelAuthStatusLoading = false;
  @state() modelAuthStatusResult: ModelAuthStatusResult | null = null;
  @state() modelAuthStatusError: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSummary | null = null;
  @state() debugModels: ModelCatalogEntry[] = [];
  @state() debugHeartbeat: unknown = null;
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
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

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
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private topbarObserver: ResizeObserver | null = null;
  private globalKeydownHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      this.paletteOpen = !this.paletteOpen;
      if (this.paletteOpen) {
        this.paletteQuery = "";
        this.paletteActiveIndex = 0;
      }
    }
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.onSlashAction = (action: string) => {
      switch (action) {
        case "toggle-focus":
          this.applySettings({
            ...this.settings,
            chatFocusMode: !this.settings.chatFocusMode,
          });
          break;
        case "export":
          exportChatMarkdown(this.chatMessages, this.assistantName);
          break;
        case "toggle-plan-view":
          // PR-8 follow-up: `/plan view` slash command — mirrors the
          // chat-controls Plan view button. Opens the sidebar with the
          // latest live plan markdown (or a placeholder if none has
          // been emitted yet), or closes it if already showing.
          this.togglePlanViewSidebar();
          break;
        case "refresh-tools-effective": {
          void refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
          break;
        }
      }
    };
    document.addEventListener("keydown", this.globalKeydownHandler);
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.globalKeydownHandler);
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    // PR-8 follow-up Round 2: when sessions list updates OR the active
    // session changes, hydrate the plan-view markdown from
    // SessionEntry.planMode.lastPlanSteps. Restores the sidebar state
    // after a hard refresh — without this, the button shows the
    // placeholder until a fresh `update_plan` event fires.
    if (changed.has("sessionsResult") || changed.has("sessionKey")) {
      this.hydratePlanViewFromSession();
    }
    if (!changed.has("sessionKey") || this.agentsPanel !== "tools") {
      return;
    }
    const activeSessionAgentId = resolveAgentIdFromSessionKey(this.sessionKey);
    if (this.agentsSelectedId && this.agentsSelectedId === activeSessionAgentId) {
      void loadToolsEffectiveInternal(this, {
        agentId: this.agentsSelectedId,
        sessionKey: this.sessionKey,
      });
      return;
    }
    this.toolsEffectiveResult = null;
    this.toolsEffectiveResultKey = null;
    this.toolsEffectiveError = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
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

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  applyLocalUserIdentity(next: { name?: string | null; avatar?: string | null }) {
    applyLocalUserIdentityInternal(
      this as unknown as Parameters<typeof applyLocalUserIdentityInternal>[0],
      next,
    );
  }

  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
    this.navDrawerOpen = false;
  }

  setTheme(next: ThemeName, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
    this.themeOrder = this.buildThemeOrder(next);
  }

  setThemeMode(next: ThemeMode, context?: Parameters<typeof setThemeModeInternal>[2]) {
    setThemeModeInternal(
      this as unknown as Parameters<typeof setThemeModeInternal>[0],
      next,
      context,
    );
  }

  setCustomThemeImportUrl(next: string) {
    this.customThemeImportUrl = next;
    if (this.customThemeImportMessage?.kind === "error") {
      this.customThemeImportMessage = null;
    }
  }

  openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
  }

  async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
        ...this.settings,
        customTheme,
      });
      this.customThemeImportUrl = "";
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

  clearCustomTheme() {
    const nextTheme = this.theme === "custom" ? "claw" : this.theme;
    this.customThemeImportExpanded = true;
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

  setBorderRadius(value: number) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      borderRadius: value,
    });
    this.requestUpdate();
  }

  buildThemeOrder(active: ThemeName): ThemeName[] {
    const all = [...VALID_THEME_NAMES];
    const rest = all.filter((id) => id !== active);
    return [active, ...rest];
  }

  async loadOverview(opts?: { refresh?: boolean }) {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0], opts);
  }

  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
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

  async toggleRealtimeTalk() {
    if (this.realtimeTalkSession) {
      this.realtimeTalkSession.stop();
      this.realtimeTalkSession = null;
      this.realtimeTalkActive = false;
      this.realtimeTalkStatus = "idle";
      this.realtimeTalkDetail = null;
      this.realtimeTalkTranscript = null;
      return;
    }
    if (!this.client || !this.connected) {
      this.lastError = "Gateway not connected";
      return;
    }
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

  async steerQueuedChatMessage(id: string) {
    await steerQueuedChatMessageInternal(
      this as unknown as Parameters<typeof steerQueuedChatMessageInternal>[0],
      id,
    );
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

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      const method = active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
      await this.client.request(method, {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  /**
   * PR-8 / #67721: resolve a pending plan-approval card.
   *
   * Flow:
   *   1. Snapshot the active request + clear UI state OPTIMISTICALLY so
   *      the card disappears immediately. Avoids the stale-card-double-click
   *      scenario where users click Accept twice and the second click
   *      hits "planApproval requires an active plan-mode session".
   *   2. POST sessions.patch { planApproval } so the server transitions
   *      SessionEntry.planMode via resolvePlanApproval (#67538).
   *   3. On success, send a follow-up message to the agent so it
   *      auto-continues without the user having to type "go". This is
   *      the [APPROVED_PLAN] / [PLAN_DECISION] context injection
   *      from the original PR-8 design, delivered via sessions.send
   *      (which the chat surface already uses for user messages).
   *   4. On failure, restore the card so the user can retry.
   */
  async handlePlanApprovalDecision(
    decision: "approve" | "reject" | "edit",
    feedback?: string,
  ): Promise<void> {
    const active = this.planApprovalRequest;
    if (!active || !this.client || this.planApprovalBusy) {
      return;
    }
    this.planApprovalBusy = true;
    this.planApprovalError = null;
    // Optimistic dismissal — clear card BEFORE the round-trip so a
    // second click can't fire while the first is in-flight.
    const snapshotRequest = active;
    const snapshotReviseDraft = this.planApprovalReviseDraft;
    this.planApprovalRequest = null;
    this.planApprovalReviseOpen = false;
    this.planApprovalReviseDraft = "";
    try {
      const params: Record<string, unknown> = {
        key: active.sessionKey,
        planApproval: {
          action: decision,
          ...(active.approvalId ? { approvalId: active.approvalId } : {}),
          ...(feedback && feedback.trim() ? { feedback: feedback.trim() } : {}),
        },
        // After approve/edit, also CLEAR session-level permission
        // overrides so the chip falls back to "Default permissions"
        // (whatever's in agents.defaults / per-agent config). User
        // feedback: post-plan-mode shouldn't lock into Ask just
        // because Ask was active before. Reject leaves overrides
        // alone (still in plan mode, no permission change needed).
        ...(decision === "approve" || decision === "edit"
          ? { execSecurity: null, execAsk: null }
          : {}),
      };
      await this.client.request("sessions.patch", params);
      // Send a synthetic "decision" message so the agent gets a user
      // turn to react to. Without this the agent sits idle waiting
      // for input even though the runtime has flipped mode → normal.
      // We use handleSendChat (the same path the user types into) so
      // the message appears in chat history and triggers a normal
      // agent run with the same session key.
      const decisionMessage = buildPlanDecisionUserMessage(
        decision,
        active.summary ?? null,
        feedback ?? null,
      );
      // Fire-and-forget; the agent run is its own lifecycle and
      // shouldn't block the approval flow's success state.
      void handleSendChatInternal(this, decisionMessage).catch((err: unknown) => {
        this.lastError = `Plan accepted but failed to notify agent: ${String(err)}`;
      });
    } catch (err) {
      // Restore card so the user can retry.
      this.planApprovalRequest = snapshotRequest;
      this.planApprovalReviseDraft = snapshotReviseDraft;
      this.planApprovalError = `Plan approval failed: ${String(err)}`;
    } finally {
      this.planApprovalBusy = false;
    }
  }

  /** Open the inline revise textarea (no popup). */
  handlePlanApprovalReviseOpen(): void {
    if (!this.planApprovalRequest) {
      return;
    }
    this.planApprovalReviseOpen = true;
    this.planApprovalError = null;
  }

  /**
   * PR-10 AskUserQuestion: route the user's answer back to the agent.
   * Same approval-card surface as plan approve/reject/edit, but the
   * action verb is "answer" — no plan-mode state transition, the
   * answer arrives as a synthetic user message tagged
   * `[QUESTION_ANSWER]` so the agent's next turn can act on it.
   */
  async handlePlanApprovalAnswer(answer: string): Promise<void> {
    const active = this.planApprovalRequest;
    if (!active || !this.client || this.planApprovalBusy) {
      return;
    }
    if (!active.question) {
      // Defensive: only fire when the approval is actually a question.
      return;
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      return;
    }
    this.planApprovalBusy = true;
    this.planApprovalError = null;
    const snapshotRequest = active;
    this.planApprovalRequest = null;
    try {
      await this.client.request("sessions.patch", {
        key: active.sessionKey,
        planApproval: {
          action: "answer",
          answer: trimmed,
          ...(active.approvalId ? { approvalId: active.approvalId } : {}),
        },
      });
      // Inject `[QUESTION_ANSWER]` as a synthetic user message so the
      // agent's next turn can act on the answer. Plan-mode state is
      // unchanged — the agent continues its planning cycle.
      const message = `[QUESTION_ANSWER] ${trimmed}`;
      void handleSendChatInternal(this, message).catch((err: unknown) => {
        this.lastError = `Question answered but failed to notify agent: ${String(err)}`;
      });
    } catch (err) {
      this.planApprovalRequest = snapshotRequest;
      this.planApprovalError = `Question answer failed: ${String(err)}`;
    } finally {
      this.planApprovalBusy = false;
    }
  }

  /** Cancel the inline revise textarea WITHOUT submitting. */
  handlePlanApprovalReviseCancel(): void {
    this.planApprovalReviseOpen = false;
    this.planApprovalReviseDraft = "";
    this.planApprovalError = null;
  }

  handlePlanApprovalReviseDraftChange(text: string): void {
    this.planApprovalReviseDraft = text;
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() || "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      token: nextToken,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: SidebarContent) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    // Capture the chat thread's scroll position before opening the
    // sidebar — the layout reflow on .chat-main flex change otherwise
    // resets the chat container scroll to top, yanking the user away
    // from where they were reading. Restore on the next animation
    // frame after Lit re-renders.
    const threadEl = this.renderRoot?.querySelector?.(".chat-thread");
    const savedScrollTop = threadEl instanceof HTMLElement ? threadEl.scrollTop : null;
    const wasNearBottom =
      threadEl instanceof HTMLElement
        ? threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 60
        : false;
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
    if (savedScrollTop !== null) {
      // Defer to after the layout reflow completes.
      requestAnimationFrame(() => {
        const after = this.renderRoot?.querySelector?.(".chat-thread");
        if (!(after instanceof HTMLElement)) {
          return;
        }
        if (wasNearBottom) {
          // Sticky bottom — pin to the new bottom after reflow.
          after.scrollTop = after.scrollHeight;
        } else {
          after.scrollTop = savedScrollTop;
        }
      });
    }
  }

  /**
   * PR-8 follow-up: live update_plan refresh — every time the agent
   * calls update_plan during execution, re-render the sidebar
   * markdown so the user sees the latest checklist (boxes ticking off
   * as the agent steps through). No-op if the sidebar isn't currently
   * open with markdown content (don't yank focus from a different
   * view the user is on).
   */
  refreshLivePlanSidebar(
    plan: import("./app-tool-stream.ts").PlanApprovalRequest["plan"],
    summary?: string,
  ): void {
    const md = buildPlanViewMarkdown(plan, summary);
    // ALWAYS track latest plan so the chat-controls "Plan view" button
    // and `/plan view` slash command can re-open the sidebar with current
    // content. Sidebar content is only updated if it's already showing
    // a markdown plan (don't yank focus from a different open view).
    this.latestPlanMarkdown = md;
    if (this.sidebarOpen && this.sidebarContent?.kind === "markdown") {
      this.sidebarContent = { kind: "markdown", content: md };
    }
  }

  /**
   * PR-8 follow-up Round 2: rebuild `latestPlanMarkdown` from the
   * persisted `SessionEntry.planMode.lastPlanSteps` snapshot for the
   * current session. Called when the sessions list updates so the
   * Plan view button shows the latest plan after a hard refresh —
   * before this hydrates, only stream events would update the markdown
   * and a fresh subscription doesn't replay prior `update_plan` events.
   *
   * No-op when no snapshot exists for the active session (button still
   * shows the placeholder) or when a snapshot is already loaded with
   * the same content (avoids stomping fresher live-stream state).
   */
  hydratePlanViewFromSession(): void {
    const activeSessionKey = this.sessionKey;
    if (!activeSessionKey || !this.sessionsResult) {
      return;
    }
    const row = this.sessionsResult.sessions.find((s) => s.key === activeSessionKey);
    const snapshot = row?.planMode?.lastPlanSteps;
    if (!snapshot || snapshot.length === 0) {
      return;
    }
    const md = buildPlanViewMarkdown(snapshot);
    if (md === this.latestPlanMarkdown) {
      return;
    }
    this.latestPlanMarkdown = md;
    // If the sidebar is currently showing the placeholder for THIS
    // session, swap it for the real plan. Don't yank focus from a
    // different view the user is on.
    if (
      this.sidebarOpen &&
      this.sidebarContent?.kind === "markdown" &&
      this.sidebarContent.content === PLAN_VIEW_PLACEHOLDER_MARKDOWN
    ) {
      this.sidebarContent = { kind: "markdown", content: md };
    }
  }

  /**
   * PR-8 follow-up: open the most-recent active plan in the right
   * sidebar. Used by both the chat-controls "Plan view" button and
   * the `/plan view` slash command. If the sidebar is already showing
   * the plan (or the placeholder), toggle it closed. If no plan has
   * been tracked yet, render the placeholder so the user knows the
   * affordance exists.
   *
   * Round 2 fix: previously the close-check required
   * `latestPlanMarkdown !== null`, but opening with the placeholder
   * doesn't populate that field, so the second click never matched
   * the close branch. Now the close branch fires when the sidebar
   * shows EITHER the live plan markdown OR the shared placeholder
   * constant, so the toggle is symmetric for both states.
   */
  togglePlanViewSidebar(): void {
    const sidebarMd =
      this.sidebarOpen && this.sidebarContent?.kind === "markdown"
        ? this.sidebarContent.content
        : null;
    const isShowingPlanContent =
      sidebarMd !== null &&
      (sidebarMd === this.latestPlanMarkdown || sidebarMd === PLAN_VIEW_PLACEHOLDER_MARKDOWN);
    if (isShowingPlanContent) {
      this.handleCloseSidebar();
      return;
    }
    this.handleOpenSidebar({
      kind: "markdown",
      content: this.latestPlanMarkdown ?? PLAN_VIEW_PLACEHOLDER_MARKDOWN,
    });
  }

  /**
   * PR-8 follow-up: render the proposed plan as markdown and open it
   * in the right sidebar (read-only viewer, same path tool-output
   * details use). Called both from the inline card's "Open plan"
   * button AND auto-fired by handlePlanApprovalEvent when a fresh
   * approval arrives so the user sees the full plan immediately.
   */
  openPlanInSidebar(request: import("./app-tool-stream.ts").PlanApprovalRequest): void {
    // PR-9 Tier 1: prefer the agent-supplied title (filtered the same
    // way as the inline-card headline) over summary, then fall back to
    // "Proposed plan" so pre-Tier-1 agents render unchanged.
    const rawTitle = request.title?.trim();
    const isGenericTitle =
      !rawTitle || rawTitle === "Plan approval requested" || rawTitle.startsWith("Plan approval —");
    const headerCandidate = !isGenericTitle ? rawTitle : request.summary || "Proposed plan";
    // PR-10: pass archetype fields so the sidebar markdown shows the
    // full plan structure (analysis / assumptions / risks / verification
    // / references) instead of just the step checklist.
    const md = buildPlanViewMarkdown(request.plan, headerCandidate, {
      ...(request.analysis ? { analysis: request.analysis } : {}),
      ...(request.assumptions ? { assumptions: request.assumptions } : {}),
      ...(request.risks ? { risks: request.risks } : {}),
      ...(request.verification ? { verification: request.verification } : {}),
      ...(request.references ? { references: request.references } : {}),
    });
    this.handleOpenSidebar({ kind: "markdown", content: md });
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
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

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  render() {
    return renderApp(this as unknown as AppViewState);
  }
}
