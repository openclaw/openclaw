/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    settings: {
      gatewayUrl: "ws://localhost:18789",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      textScale: 100,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    password: "",
    loginShowGatewayToken: false,
    loginShowGatewayPassword: false,
    tab: "skillWorkshop",
    onboarding: false,
    basePath: "",
    connected: true,
    theme: "claw",
    themeMode: "dark",
    themeResolved: "dark",
    themeOrder: ["claw", "knot", "dash"],
    customThemeImportUrl: "",
    customThemeImportBusy: false,
    customThemeImportMessage: null,
    customThemeImportExpanded: false,
    customThemeImportFocusToken: 0,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    chatError: null,
    eventLog: [],
    assistantName: "Nova",
    assistantAvatar: "/avatar/main",
    assistantAvatarUploadBusy: false,
    assistantAvatarUploadError: null,
    assistantAgentId: "main",
    localMediaPreviewRoots: [],
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    sessionKey: "main",
    chatLoading: false,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatMessages: [],
    chatToolMessages: [],
    activityEntries: [],
    activityFilterText: "",
    activityStatusFilters: { running: true, done: true, error: true },
    activityToolFilter: "all",
    activityExpandedIds: new Set(),
    activityAutoFollow: true,
    activityAtBottom: true,
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set(),
    compactionStatus: null,
    fallbackStatus: null,
    chatRunStatus: null,
    chatAvatarUrl: null,
    chatThinkingLevel: null,
    chatModelOverrides: {},
    chatModelSwitchPromises: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
    sessionSwitchNotice: null,
    sessionSwitchFlashKey: null,
    chatSessionPickerOpen: false,
    chatSessionPickerSurface: null,
    chatSessionPickerQuery: "",
    chatSessionPickerAppliedQuery: "",
    chatSessionPickerLoading: false,
    chatSessionPickerError: null,
    chatSessionPickerResult: null,
    chatQueue: [],
    chatQueueBySession: {},
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    realtimeTalkConversation: [],
    realtimeTalkOptionsOpen: false,
    realtimeTalkOptions: {
      provider: "",
      model: "",
      voice: "",
      transport: "",
      vadThreshold: "",
      silenceDurationMs: "",
      prefixPaddingMs: "",
      reasoningEffort: "",
    },
    updateRealtimeTalkOptions: vi.fn(),
    chatManualRefreshInFlight: false,
    chatHeaderControlsHidden: false,
    chatMobileControlsOpen: false,
    nodesLoading: false,
    nodes: [],
    chatNewMessagesBelow: false,
    navDrawerOpen: false,
    sidebarOpen: false,
    sidebarContent: null,
    sidebarError: null,
    splitRatio: 0.6,
    scrollToBottom: vi.fn(),
    presenceEntries: [],
    devicesLoading: false,
    devicesError: null,
    devicesList: null,
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalError: null,
    pendingGatewayUrl: null,
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configValid: true,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    updateRunning: false,
    applySessionKey: "main",
    configSnapshot: { config: {}, hash: "hash" } as AppViewState["configSnapshot"],
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: null as unknown as AppViewState["configUiHints"],
    configForm: {},
    configFormOriginal: {},
    selectedAgentId: null,
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    dreamingRestartConfirmOpen: false,
    dreamingRestartConfirmLoading: false,
    dreamingPendingEnabled: null,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryEntries: [],
    dreamDiaryCursor: null,
    dreamDiaryHasMore: false,
    dreamDiarySelectedId: null,
    dreamsConfig: null,
    dreamsConfigLoading: false,
    dreamsConfigSaving: false,
    dreamsConfigError: null,
    dreamsConfigMessage: null,
    dreamsConfigForm: null,
    dreamForgeLoading: false,
    dreamForgeGenerating: false,
    dreamForgeError: null,
    dreamForgeResult: null,
    dreamForgePrompt: "",
    dreamForgeAgentId: "",
    dreamForgeModel: "",
    dreamForgeThinking: "",
    dreamForgeRecentMemories: [],
    configActiveSection: null,
    configActiveSubsection: null,
    communicationsActiveSection: null,
    communicationsActiveSubsection: null,
    appearanceActiveSection: null,
    appearanceActiveSubsection: null,
    appearanceFormMode: "form",
    appearanceSearchQuery: "",
    automationActiveSection: null,
    automationActiveSubsection: null,
    infrastructureActiveSection: null,
    infrastructureActiveSubsection: null,
    aiAgentsActiveSection: null,
    aiAgentsActiveSubsection: null,
    configReady: true,
    configFormDirty: false,
    agentsList: null,
    agentsLoading: false,
    agentsError: null,
    agentsSelectedId: null,
    agentsFilesLoading: false,
    agentsFilesError: null,
    agentsFilesResult: null,
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityResult: null,
    modelAuthLoading: false,
    modelAuthError: null,
    modelAuthStatus: null,
    cronStatus: null,
    cronJobs: [],
    cronRuns: [],
    cronLoading: false,
    cronError: null,
    cronSelectedJobId: null,
    cronForm: { deliveryChannel: "", deliveryMode: "last" },
    cronFieldErrors: {},
    cronModelSuggestions: [],
    cronQuickCreateOpen: false,
    cronQuickCreateStep: "what",
    cronQuickCreateDraft: null,
    cronEditingJobId: null,
    channelsSnapshot: null,
    channelsLoading: false,
    channelsError: null,
    channelNostrProfileForms: {},
    channelsNostrProfileSaving: {},
    channelsNostrProfileErrors: {},
    channelsNostrProfiles: {},
    skillsLoading: false,
    skillsError: null,
    skillsReport: { skills: [], workspaceDir: "", managedSkillsDir: "" },
    skillSearchLoading: false,
    skillSearchError: null,
    skillSearchQuery: "",
    skillSearchResults: [],
    skillDetailLoading: false,
    skillDetailError: null,
    skillDetail: null,
    skillInstallBusy: null,
    skillInstallMessage: null,
    skillWorkshopLoading: false,
    skillWorkshopLoaded: true,
    skillWorkshopError: null,
    skillWorkshopInspectingKey: null,
    skillWorkshopProposals: [],
    skillWorkshopSelectedKey: null,
    skillWorkshopActionBusy: null,
    skillWorkshopActionNotice: null,
    skillWorkshopRevisionKey: null,
    skillWorkshopRevisionDraft: "",
    skillWorkshopStatusFilter: "all",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "board",
    skillWorkshopUseCurrentChatForRevisions: false,
    toolsLoading: false,
    toolsError: null,
    toolsCatalog: null,
    usageLoading: false,
    usageError: null,
    usageResult: null,
    usageCostSummary: null,
    usageStartDate: "",
    usageEndDate: "",
    usageScope: "family",
    usageAgentId: null,
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageSelectedHours: [],
    usageQuery: "",
    usageQueryDraft: "",
    usageQueryDebounceTimer: null,
    usageTimeZone: "local",
    logsLoading: false,
    logsError: null,
    logs: [],
    logLevelFilter: "all",
    logSearchQuery: "",
    statusLoading: false,
    statusError: null,
    status: null,
    healthLoading: false,
    healthError: null,
    health: null,
    attentionItems: [],
    applySettings: vi.fn(),
    connect: vi.fn(),
    setTab: vi.fn(),
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setCustomThemeImportUrl: vi.fn(),
    openCustomThemeImport: vi.fn(),
    importCustomTheme: vi.fn(),
    clearCustomTheme: vi.fn(),
    setBorderRadius: vi.fn(),
    setTextScale: vi.fn(),
    applyLocalUserIdentity: vi.fn(),
    loadOverview: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    loadCron: vi.fn(),
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    applyConfig: vi.fn(),
    loadAgents: vi.fn(),
    loadAgentFiles: vi.fn(),
    loadAgentIdentity: vi.fn(),
    loadModelAuth: vi.fn(),
    loadChannels: vi.fn(),
    loadSkills: vi.fn(),
    loadSkillSearch: vi.fn(),
    loadSkillDetail: vi.fn(),
    installSkill: vi.fn(),
    loadTools: vi.fn(),
    loadUsage: vi.fn(),
    loadLogs: vi.fn(),
    loadStatus: vi.fn(),
    loadHealth: vi.fn(),
    loadDevices: vi.fn(),
    loadExecApprovals: vi.fn(),
    saveExecApprovals: vi.fn(),
    respondToExecApproval: vi.fn(),
    updatePendingGatewayUrl: vi.fn(),
    clearPendingGatewayUrl: vi.fn(),
    sendChat: vi.fn(),
    cancelChat: vi.fn(),
    clearChat: vi.fn(),
    retryChatQueueItem: vi.fn(),
    removeChatQueueItem: vi.fn(),
    refreshChat: vi.fn(),
    refreshSessions: vi.fn(),
    switchSession: vi.fn(),
    setChatMobileControlsOpen: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
}

beforeEach(async () => {
  localStorageValues.clear();
  await i18n.setLocale("en");
});

describe("renderApp Skill Workshop mode switcher (rendered proof)", () => {
  it("renders the mode switcher with resolved English labels", () => {
    const container = document.createElement("div");
    render(
      renderApp(
        createState({
          tab: "skillWorkshop",
          skillWorkshopMode: "board",
          skillWorkshopQuery: "",
          skillWorkshopProposals: [],
        }),
      ),
      container,
    );

    const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
    expect(tablist, "expected .sw-mode-switch to render").not.toBeNull();
    expect(tablist?.getAttribute("role")).toBe("tablist");
    expect(tablist?.getAttribute("aria-label")).toBe(t("skillWorkshop.modeSwitcher.label"));
    expect(tablist?.getAttribute("aria-label")).toBe("Workshop view");

    const buttons = tablist?.querySelectorAll<HTMLButtonElement>(".sw-mode-switch__opt");
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.getAttribute("title")).toBe("Board view");
    expect(buttons?.[0]?.textContent?.trim()).toBe("Board");
    expect(buttons?.[0]?.getAttribute("aria-selected")).toBe("true");
    expect(buttons?.[1]?.getAttribute("title")).toBe("Today view");
    expect(buttons?.[1]?.textContent?.trim()).toBe("Today");
    expect(buttons?.[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("falls back to English for the new keys when locale has no translation", async () => {
    // These sample locales still render the new keys from fallback metadata
    // until translators run, so the switcher should match the English render.
    const locales = ["de", "es", "ja-JP", "zh-CN", "ar", "fr"] as const;
    for (const locale of locales) {
      await i18n.setLocale(locale);
      const container = document.createElement("div");
      render(
        renderApp(
          createState({
            tab: "skillWorkshop",
            skillWorkshopMode: "board",
            skillWorkshopQuery: "",
            skillWorkshopProposals: [],
          }),
        ),
        container,
      );

      const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
      expect(tablist, `${locale}: .sw-mode-switch`).not.toBeNull();
      expect(tablist?.getAttribute("aria-label"), `${locale}: aria-label`).toBe("Workshop view");
      const buttons = tablist?.querySelectorAll<HTMLButtonElement>(".sw-mode-switch__opt");
      expect(buttons?.[0]?.getAttribute("title"), `${locale}: board title`).toBe("Board view");
      expect(buttons?.[0]?.textContent?.trim(), `${locale}: board text`).toBe("Board");
      expect(buttons?.[1]?.getAttribute("title"), `${locale}: today title`).toBe("Today view");
      expect(buttons?.[1]?.textContent?.trim(), `${locale}: today text`).toBe("Today");
    }
  });

  it("emits the rendered switcher HTML for the PR proof (de locale)", async () => {
    // This is the "copied live output" the PR needs. We render the actual
    // Control UI render path with a non-English locale and dump the resulting
    // switcher HTML so the contributor can paste it into the PR body.
    await i18n.setLocale("de");
    const container = document.createElement("div");
    render(
      renderApp(
        createState({
          tab: "skillWorkshop",
          skillWorkshopMode: "board",
          skillWorkshopQuery: "",
          skillWorkshopProposals: [],
        }),
      ),
      container,
    );

    const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
    expect(tablist).not.toBeNull();
    const rendered = tablist?.outerHTML ?? "";
    process.stdout.write("\n--- rendered .sw-mode-switch (de) ---\n");
    process.stdout.write(rendered);
    process.stdout.write("\n--- end rendered ---\n");
    expect(rendered).toContain('aria-label="Workshop view"');
    expect(rendered).toContain('title="Board view"');
    expect(rendered).toContain('title="Today view"');
    expect(rendered).toMatch(/>Board<\/span>/);
    expect(rendered).toMatch(/>Today<\/span>/);
  });
});
