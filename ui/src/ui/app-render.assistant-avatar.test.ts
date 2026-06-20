/* @vitest-environment jsdom */

import { html, render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../app-routes.ts";
import { i18n } from "../i18n/index.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { ChatProps } from "./views/chat.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";

const quickSettingsProps = vi.hoisted(() => ({
  current: null as QuickSettingsProps | null,
}));
const chatProps = vi.hoisted(() => ({
  current: null as ChatProps | null,
}));
const localStorageValues = vi.hoisted(() => new Map<string, string>());
const renderChatControlsMock = vi.hoisted(() => vi.fn(() => "chat-controls"));

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
  renderChat: (props: ChatProps) => {
    chatProps.current = props;
    return html`<div data-testid="chat">${props.composerControls}</div>`;
  },
  resetChatViewState: vi.fn(),
}));

vi.mock("./app-render.helpers.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-render.helpers.ts")>();
  return {
    ...actual,
    renderChatControls: renderChatControlsMock,
  };
});

vi.mock("./icons.ts", () => ({
  icons: {},
}));

import { renderApp } from "./app-render.ts";
import { saveLocalAssistantIdentity } from "./storage.ts";

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
    routeId: "config",
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
    chatVerboseLevel: null,
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
    refreshSessionsAfterChat: new Map(),
    connect: vi.fn(),
    setRoute: vi.fn(),
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setCustomThemeImportUrl: vi.fn(),
    openCustomThemeImport: vi.fn(),
    importCustomTheme: vi.fn(),
    clearCustomTheme: vi.fn(),
    setBorderRadius: vi.fn(),
    setTextScale: vi.fn(),
    applySettings: vi.fn(),
    applyLocalUserIdentity: vi.fn(),
    loadOverview: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    loadCron: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
}

beforeEach(async () => {
  await i18n.setLocale("en");
  await Promise.all(
    ["config", "chat", "logs", "sessions", "nodes", "workboard"].map((routeId) =>
      appRouter.loadRouteChunk(routeId),
    ),
  );
  localStorageValues.clear();
  quickSettingsProps.current = null;
  chatProps.current = null;
  renderChatControlsMock.mockClear();
});

describe("renderApp assistant avatar routing", () => {
  it("passes the browser-local assistant override to Quick Settings ahead of stale identity metadata", () => {
    const dataUrl = "data:image/png;base64,bG9jYWwtYXNzaXN0YW50";
    saveLocalAssistantIdentity({ avatar: dataUrl, agentId: "main" });

    renderApp(createState());

    expect(quickSettingsProps.current?.assistantAvatar).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarUrl).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarSource).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarStatus).toBe("data");
    expect(quickSettingsProps.current?.assistantAvatarReason).toBeNull();
    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(dataUrl);
  });

  it("uses the active session agent override while identity metadata is stale", () => {
    saveLocalAssistantIdentity({
      avatar: "data:image/png;base64,bWFpbg==",
      agentId: "main",
    });
    saveLocalAssistantIdentity({
      avatar: "data:image/png;base64,d29ya2Vy",
      agentId: "worker",
    });

    renderApp(
      createState({
        sessionKey: "agent:worker:main",
        assistantAgentId: "main",
      }),
    );

    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(
      "data:image/png;base64,d29ya2Vy",
    );
  });

  it("uses the default agent override for a bare main session while identity metadata is stale", () => {
    saveLocalAssistantIdentity({
      avatar: "data:image/png;base64,bWFpbg==",
      agentId: "main",
    });
    saveLocalAssistantIdentity({
      avatar: "data:image/png;base64,d29ya2Vy",
      agentId: "worker",
    });

    renderApp(
      createState({
        sessionKey: "main",
        assistantAgentId: "worker",
      }),
    );

    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(
      "data:image/png;base64,bWFpbg==",
    );
  });

  it("reloads the default agent identity after clearing its override from a bare main session", async () => {
    const loadAssistantIdentity = vi.fn(async () => undefined);
    saveLocalAssistantIdentity({
      avatar: "data:image/png;base64,YWxwaGE=",
      agentId: "alpha",
    });

    renderApp(
      createState({
        sessionKey: "main",
        assistantAgentId: "worker",
        agentsList: {
          defaultId: "alpha",
          agents: [
            { id: "alpha", name: "Alpha" },
            { id: "worker", name: "Worker" },
          ],
        } as AppViewState["agentsList"],
        loadAssistantIdentity,
      }),
    );

    await quickSettingsProps.current?.onAssistantAvatarClearOverride?.();

    expect(loadAssistantIdentity).toHaveBeenCalledWith({
      sessionKey: "agent:alpha:main",
      expectedSessionKey: "main",
    });
  });

  it("applies the configured chat message width as a shell CSS variable", () => {
    const container = document.createElement("div");

    render(
      renderApp(createState({ routeId: "chat", chatMessageMaxWidth: "min(1280px, 82%)" })),
      container,
    );

    const shell = container.querySelector<HTMLElement>(".shell");
    expect(shell?.style.getPropertyValue("--chat-message-max-width")).toBe("min(1280px, 82%)");
  });

  it("marks the logs route so the page can hand scroll ownership to the log stream", () => {
    const container = document.createElement("div");

    render(renderApp(createState({ routeId: "logs" })), container);

    const content = container.querySelector<HTMLElement>(".content--logs");
    expect(content?.classList.contains("content--logs")).toBe(true);
    expect(content?.classList.contains("content--chat")).toBe(false);
  });

  it("auto-expands chat tool calls when the effective verbose level is full", () => {
    renderApp(createState({ tab: "chat", chatVerboseLevel: "full" }));

    expect(chatProps.current?.autoExpandToolCalls).toBe(true);
  });

  it("keeps chat tool calls collapsed by default for non-full verbose levels", () => {
    renderApp(createState({ tab: "chat", chatVerboseLevel: "tokens" }));

    expect(chatProps.current?.autoExpandToolCalls).toBe(false);
  });

  it("does not render chat errors in non-chat page headers", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "sessions",
          lastError: "transient tool failure",
          chatError: "transient tool failure",
        }),
      ),
      container,
    );

    expect(container.querySelector(".page-meta .pill.danger")?.textContent?.trim()).toBeUndefined();
  });

  it("keeps non-chat global errors visible in non-chat page headers", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "nodes",
          lastError: "node list failed",
          chatError: "previous chat failure",
        }),
      ),
      container,
    );

    expect(container.querySelector(".page-meta .pill.danger")?.textContent?.trim()).toBe(
      "node list failed",
    );
  });

  it("shows a retryable Workboard config error after config loading fails", async () => {
    const request = vi.fn(async () => ({
      config: {},
      hash: "hash-reloaded",
      issues: [],
      raw: "{}",
      valid: true,
    }));
    const state = createState({
      routeId: "workboard",
      client: { request } as unknown as AppViewState["client"],
      configLoading: false,
      configSnapshot: null,
      lastError: "config.get failed",
    });
    const container = document.createElement("div");

    await vi.waitFor(() => {
      render(renderApp(state), container);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("config.get failed");
    });

    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Retry")
      ?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.get", {});
    });
  });

  it("routes chat errors through the chat view instead of the shared header", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          lastError: "transient tool failure",
          chatError: "transient tool failure",
        }),
      ),
      container,
    );

    expect(container.querySelector(".page-meta .pill.danger")?.textContent?.trim()).toBeUndefined();
    expect(chatProps.current?.error).toBe("transient tool failure");
  });

  it("routes newer global errors through the chat view ahead of stale chat errors", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          lastError: "gateway disconnected",
          chatError: "previous chat failure",
        }),
      ),
      container,
    );

    expect(chatProps.current?.error).toBe("gateway disconnected");
  });

  it("does not rebuild chat composer controls for draft-only rerenders", () => {
    const container = document.createElement("div");
    const state = createState({ routeId: "chat", chatMessage: "" });

    render(renderApp(state), container);
    state.chatMessage = "h";
    render(renderApp(state), container);
    state.chatMessage = "hello";
    render(renderApp(state), container);

    expect(renderChatControlsMock).toHaveBeenCalledTimes(1);

    state.chatSending = true;
    render(renderApp(state), container);

    expect(renderChatControlsMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds chat composer controls after locale changes", async () => {
    const container = document.createElement("div");
    const state = createState({ routeId: "chat", chatMessage: "" });

    render(renderApp(state), container);
    await i18n.setLocale("zh-CN");
    render(renderApp(state), container);

    expect(renderChatControlsMock).toHaveBeenCalledTimes(2);
  });

  it("passes security quick setting fields to Quick Settings", () => {
    const state = createState({
      configForm: {
        browser: { enabled: false },
        tools: { profile: "messaging", exec: { security: "full" } },
        agents: { defaults: { exec: { security: "deny" } } },
      },
    });

    renderApp(state);

    expect(quickSettingsProps.current?.security.execPolicy).toBe("full");
    expect(quickSettingsProps.current?.security.browserEnabled).toBe(false);
    expect(quickSettingsProps.current?.security.toolProfile).toBe("messaging");

    quickSettingsProps.current?.onBrowserEnabledToggle?.(true);
    quickSettingsProps.current?.onToolProfileChange?.("full");

    expect(state.configForm?.browser).toEqual({ enabled: true });
    const tools = state.configForm?.tools as
      | { profile?: string; exec?: { security?: string } }
      | undefined;
    expect(tools?.profile).toBe("full");
    expect(tools?.exec?.security).toBe("full");
  });

  it("passes effective fast mode to Quick Settings", () => {
    const state = createState({
      sessionsResult: {
        ts: 0,
        path: "",
        count: 1,
        defaults: {},
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            effectiveFastMode: "auto",
          },
        ],
      } as AppViewState["sessionsResult"],
    });

    renderApp(state);

    expect(quickSettingsProps.current?.fastMode).toBe("auto");
  });

  it("renders stale cron state containing a job without a payload", () => {
    const container = document.createElement("div");

    render(
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
      container,
    );

    expect(container.querySelector(".shell")).toBeInstanceOf(HTMLElement);
  });

  it("filters sidebar recent sessions to the active chat agent", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          sessionKey: "agent:work:main",
          assistantAgentId: "work",
          agentsList: {
            defaultId: "main",
            agents: [
              { id: "main", name: "Main" },
              { id: "work", name: "Work" },
            ],
          } as AppViewState["agentsList"],
          sessionsResult: {
            ts: 0,
            path: "",
            count: 3,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              {
                key: "agent:main:dashboard:old",
                kind: "direct",
                label: "Main old",
                updatedAt: 30,
              },
              {
                key: "agent:work:dashboard:new",
                kind: "direct",
                label: "Work new",
                updatedAt: 20,
              },
              {
                key: "agent:work:dashboard:older",
                kind: "direct",
                label: "Work older",
                updatedAt: 10,
              },
            ],
          } as AppViewState["sessionsResult"],
        }),
      ),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".sidebar-recent-session__name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(labels).toEqual(["Work new", "Work older"]);
  });

  it("keeps legacy main sessions tied to the default agent when identity is stale", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          sessionKey: "main",
          assistantAgentId: "work",
          agentsList: {
            defaultId: "main",
            agents: [
              { id: "main", name: "Main" },
              { id: "work", name: "Work" },
            ],
          } as AppViewState["agentsList"],
          sessionsResult: {
            ts: 0,
            path: "",
            count: 3,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                label: "Main legacy",
                updatedAt: 30,
              },
              {
                key: "agent:main:dashboard:old",
                kind: "direct",
                label: "Main old",
                updatedAt: 20,
              },
              {
                key: "agent:work:dashboard:new",
                kind: "direct",
                label: "Work new",
                updatedAt: 10,
              },
            ],
          } as AppViewState["sessionsResult"],
        }),
      ),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".sidebar-recent-session__name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(labels).toEqual(["Main legacy", "Main old"]);
  });

  it("uses hello default agent for global sidebar sessions before agent list hydration", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          sessionKey: "global",
          assistantAgentId: null,
          agentsList: null,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "ops",
              },
            },
          } as AppViewState["hello"],
          sessionsResult: {
            ts: 0,
            path: "",
            count: 2,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              {
                key: "agent:main:dashboard:old",
                kind: "direct",
                label: "Main old",
                updatedAt: 20,
              },
              {
                key: "agent:ops:dashboard:new",
                kind: "direct",
                label: "Ops new",
                updatedAt: 10,
              },
            ],
          } as AppViewState["sessionsResult"],
        }),
      ),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".sidebar-recent-session__name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(labels).toEqual(["Ops new"]);
  });

  it("keeps unknown sidebar sessions unscoped", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createState({
          routeId: "chat",
          sessionKey: "unknown",
          assistantAgentId: "work",
          agentsList: {
            defaultId: "main",
            agents: [
              { id: "main", name: "Main" },
              { id: "work", name: "Work" },
            ],
          } as AppViewState["agentsList"],
          sessionsResult: {
            ts: 0,
            path: "",
            count: 3,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              {
                key: "agent:main:dashboard:old",
                kind: "direct",
                label: "Main old",
                updatedAt: 30,
              },
              {
                key: "agent:work:dashboard:new",
                kind: "direct",
                label: "Work new",
                updatedAt: 20,
              },
              {
                key: "unknown",
                kind: "unknown",
                label: "Unknown sentinel",
                updatedAt: 10,
              },
            ],
          } as AppViewState["sessionsResult"],
        }),
      ),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".sidebar-recent-session__name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(labels).toEqual(["Main old", "Work new"]);
  });
});
