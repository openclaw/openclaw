/* @vitest-environment jsdom */

import { html, render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "./app-view-state.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";

const quickSettingsProps = vi.hoisted(() => ({
  current: null as QuickSettingsProps | null,
}));
const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./views/config-quick.ts", () => ({
  renderQuickSettings: (props: QuickSettingsProps) => {
    quickSettingsProps.current = props;
    return html`<div data-testid="quick-settings"></div>`;
  },
}));

vi.mock("./views/chat.ts", () => ({
  renderChat: () => html`<div data-testid="chat"></div>`,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

import { renderApp } from "./app-render.ts";
import { saveLocalAssistantIdentity } from "./storage.ts";

async function flushLazyViews() {
  await vi.dynamicImportSettled();
}

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
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    password: "",
    loginShowGatewayToken: false,
    loginShowGatewayPassword: false,
    tab: "config",
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
    eventLog: [],
    assistantName: "Nova",
    assistantAvatar: "/avatar/main",
    assistantAvatarSource: "avatars/missing.png",
    assistantAvatarStatus: "none",
    assistantAvatarReason: "missing",
    assistantAvatarUploadBusy: false,
    assistantAvatarUploadError: null,
    assistantAgentId: "main",
    userName: null,
    userAvatar: null,
    localMediaPreviewRoots: [],
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    chatMessageMaxWidth: null,
    sessionKey: "main",
    chatLoading: false,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatMessages: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set(),
    compactionStatus: null,
    fallbackStatus: null,
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatThinkingLevel: null,
    chatModelOverrides: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
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
    chatManualRefreshInFlight: false,
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
    sessionsResult: null,
    cronStatus: null,
    configSettingsMode: "quick",
    configForm: {},
    configSnapshot: { config: {}, hash: "hash" } as AppViewState["configSnapshot"],
    configFormDirty: false,
    configSaving: false,
    configApplying: false,
    cronJobs: [],
    skillsReport: {
      skills: [],
      workspaceDir: "",
      managedSkillsDir: "",
    } as AppViewState["skillsReport"],
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
    configRaw: "",
    configRawOriginal: "",
    configValid: true,
    configIssues: [],
    configLoading: false,
    configSchema: null,
    configSchemaLoading: false,
    configUiHints: null,
    configFormOriginal: {},
    updateRunning: false,
    agentsList: null,
    agentsSelectedId: null,
    cronModelSuggestions: [],
    cronForm: { deliveryChannel: "", deliveryMode: "last" },
    cronFieldErrors: {},
    cronError: null,
    cronQuickCreateOpen: false,
    cronQuickCreateStep: "what",
    cronQuickCreateDraft: null,
    cronEditingJobId: null,
    channelsSnapshot: null,
    execApprovalQueue: [],
    dreamingRestartConfirmOpen: false,
    dreamingRestartConfirmLoading: false,
    dreamingStatusError: null,
    client: null,
    refreshSessionsAfterChat: new Set(),
    connect: vi.fn(),
    setTab: vi.fn(),
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setCustomThemeImportUrl: vi.fn(),
    openCustomThemeImport: vi.fn(),
    importCustomTheme: vi.fn(),
    clearCustomTheme: vi.fn(),
    setBorderRadius: vi.fn(),
    applySettings: vi.fn(),
    applyLocalUserIdentity: vi.fn(),
    loadOverview: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    loadCron: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
}

beforeEach(() => {
  localStorageValues.clear();
  quickSettingsProps.current = null;
});

describe("renderApp assistant avatar routing", () => {
  it("passes the browser-local assistant override to Quick Settings ahead of stale identity metadata", async () => {
    const dataUrl = "data:image/png;base64,bG9jYWwtYXNzaXN0YW50";
    saveLocalAssistantIdentity({ avatar: dataUrl });
    const container = document.createElement("div");
    const state = createState();

    render(renderApp(state), container);
    await flushLazyViews();
    render(renderApp(state), container);

    expect(quickSettingsProps.current?.assistantAvatar).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarUrl).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarSource).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarStatus).toBe("data");
    expect(quickSettingsProps.current?.assistantAvatarReason).toBeNull();
    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(dataUrl);
  });

  it("applies the configured chat message width as a shell CSS variable", () => {
    const container = document.createElement("div");

    render(
      renderApp(createState({ tab: "chat", chatMessageMaxWidth: "min(1280px, 82%)" })),
      container,
    );

    const shell = container.querySelector<HTMLElement>(".shell");
    expect(shell?.style.getPropertyValue("--chat-message-max-width")).toBe("min(1280px, 82%)");
  });

  it("does not throw when stale cron state contains a job without a payload", () => {
    expect(() =>
      renderApp(
        createState({
          cronJobs: [
            {
              id: "bad-missing-payload",
              name: "Broken",
              enabled: true,
              createdAtMs: 0,
              updatedAtMs: 0,
              schedule: { kind: "cron", expr: "0 9 * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: undefined,
            } as unknown as AppViewState["cronJobs"][number],
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("renders the Kalshi dashboard body when the Kalshi tab is active", async () => {
    const container = document.createElement("div");
    const state = createState({
      tab: "kalshi",
      kalshiDashboard: null,
      kalshiDashboardError: null,
      kalshiDashboardLastFetchAt: null,
      kalshiDashboardLoading: false,
      kalshiDashboardPnlTimeframe: "all",
      kalshiDashboardTimeframe: "24h",
      kalshiDashboardTimezone: "America/New_York",
      loadKalshiDashboard: vi.fn(),
    });

    render(renderApp(state), container);
    await flushLazyViews();
    render(renderApp(state), container);

    expect(container.textContent).toContain("Kalshi Paper Trading");
    expect(container.textContent).toContain("Prediction market paper trading status");
    expect(container.textContent).toContain("Here’s what matters.");
    expect(container.textContent).toContain("Advanced Audit hidden");
    expect(container.textContent).toContain("Show Advanced Audit");
  });

  it("requests a rerender when Kalshi dashboard controls change", async () => {
    const container = document.createElement("div");
    const requestUpdate = vi.fn();
    const state = createState({
      tab: "kalshi",
      kalshiDashboard: null,
      kalshiDashboardError: null,
      kalshiDashboardLastFetchAt: null,
      kalshiDashboardLoading: false,
      kalshiDashboardPnlTimeframe: "all",
      kalshiDashboardShowDeepAudit: true,
      kalshiDashboardTimeframe: "24h",
      kalshiDashboardTimezone: "America/New_York",
      loadKalshiDashboard: vi.fn(),
    }) as AppViewState & { requestUpdate: () => void };
    state.requestUpdate = requestUpdate;

    render(renderApp(state), container);
    await flushLazyViews();
    render(renderApp(state), container);

    const [timezone, timeframe] = [...container.querySelectorAll("select")];
    expect(timezone).toBeDefined();
    expect(timeframe).toBeDefined();
    timezone.value = "America/Chicago";
    timezone.dispatchEvent(new Event("change", { bubbles: true }));
    timeframe.value = "7d";
    timeframe.dispatchEvent(new Event("change", { bubbles: true }));

    const sixHourPnl = [...container.querySelectorAll(".kalshi-chip")].find(
      (button) => button.textContent?.trim() === "6 hours",
    );
    sixHourPnl?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(state.kalshiDashboardTimezone).toBe("America/Chicago");
    expect(state.kalshiDashboardTimeframe).toBe("7d");
    expect(state.kalshiDashboardPnlTimeframe).toBe("6h");
    expect(requestUpdate).toHaveBeenCalledTimes(3);
  });
});
