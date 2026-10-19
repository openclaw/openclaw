/* @vitest-environment jsdom */

import { flush, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "../../app/settings.ts";
import {
  acquireBoardProviderForSession,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createPaneTestHost } from "./chat-pane-runtime.test-support.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { type ChatBoardPanel, ChatBoardResetConfirmation } from "./chat-pane-surfaces.tsx";
import { mountBoardPanel } from "./chat-pane.test-support.ts";
import { createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  closeSlot,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  sidebarActivePanel,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

// mock-isolation: isolate board data and presentation without registering the real board renderer.
vi.mock("../../components/board/board-view.ts", () => {
  if (!customElements.get("openclaw-board-view")) {
    customElements.define("openclaw-board-view", class extends HTMLElement {});
  }
  return {};
});

const swarmModuleImport = await vi.hoisted(async () => {
  const { createDeferred } = await import("../../../../test/helpers/promise.js");
  const started = createDeferred();
  const pending = createDeferred();
  return {
    started: started.promise,
    pending: pending.promise,
    markStarted: started.resolve,
    release: pending.resolve,
  };
});

vi.mock("../../lib/sessions/swarm-roster.ts", async (importOriginal) => {
  swarmModuleImport.markStarted();
  await swarmModuleImport.pending;
  return importOriginal();
});

type TestChatPane = HTMLElement & {
  boardProvider?: BoardProvider;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  state: ChatPageHost;
  createSession: () => Promise<boolean>;
  paneId: string;
  presented: boolean;
  visuallyPresented: boolean;
  readonly conversationPresented: boolean;
  presentedChanged: (presented: boolean) => void;
  sessionKey: string;
  resetConfirmation: { pending: object | undefined };
  swarm: ChatPaneRuntime["swarm"];
  routeFace: "chat" | "dashboard";
  dashboardExpanded: boolean;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  confirmConversationReset: () => Promise<boolean>;
  commitSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
  settleResetConfirmation: (confirmed: boolean) => void;
  prepareRender: () => void;
  commitRender: () => void;
  handleBoardCommand: (event: BoardCommandEvent) => void;
  showDashboard: (expanded: boolean) => void;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => ResolvedBoardView;
  renderBoardPanel: (
    board: ResolvedBoardView,
    layout: ChatPageHost["sidebarLayout"],
  ) => Parameters<typeof ChatBoardPanel>[0] | null;
  renderResetConfirmation: () => Parameters<typeof ChatBoardResetConfirmation>[0] | null;
  syncRetainedBoardSession: (board: ResolvedBoardView) => void;
  refreshSwarmRoster: () => void;
};

let theme: ReturnType<typeof createApplicationTheme>;

function createTestPane(
  sessions: SessionCapability = {} as SessionCapability,
  sessionKey = "agent:main:current",
) {
  const client = {
    request: vi.fn(async () => ({ session: { key: "agent:main:current", kind: "direct" } })),
  } as unknown as GatewayBrowserClient;
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  connectionBootstrap.synchronize({ client, connected: true });
  onTestFinished(() => connectionBootstrap.reset());
  const context = {
    theme,
    connectionBootstrap,
    sessions,
    gateway: { snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() } },
  } as unknown as ApplicationContext;
  // SAFETY: The test host forwards the protected Board controller contract to its runtime.
  const pane = createPaneTestHost(
    "openclaw-chat-board-runtime-test",
    ChatPaneRuntime,
    () => context,
  ) as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  pane.context = context;
  pane.sessionKey = sessionKey;
  pane.state = {
    ...createInitialChatRealtimeState(),
    chatError: null,
    chatLoading: false,
    chatHistoryPagination: { hasMore: false },
    chatMessages: [],
    chatToolMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamSegments: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    client,
    connected: true,
    lastError: null,
    renderLifecycle: { afterCommit: () => () => {} },
    sessionKey,
    sidebarFocusPanelId: "",
    sidebarFocusVersion: 0,
    sidebarLayout: { columns: [] },
    sessions,
    sessionsError: null,
    sessionsLoading: false,
  } as unknown as ChatPageHost;
  pane.state.updateSidebarLayout = (layout) => {
    pane.state.sidebarLayout = layout;
  };
  pane.state.updateSidebarActivePanel = (panelId) => {
    pane.state.sidebarFocusPanelId = panelId;
    pane.state.sidebarFocusVersion += 1;
  };
  pane.connectedClient = client;
  pane.connectionGeneration = 1;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  return pane;
}

function createGatewayBoardPane(params: {
  sessionKey: string;
  methods?: readonly string[];
  scopes?: readonly string[];
  capabilities?: readonly string[];
  lifecycleConnected?: boolean;
}) {
  const pane = createTestPane(undefined, params.sessionKey);
  const snapshot = { sessionKey: params.sessionKey, revision: 1, tabs: [], widgets: [] };
  const removeListener = vi.fn();
  const request = vi.fn<
    (
      method: string,
      params: { sessionKey: string; agentId?: string },
    ) => Promise<BoardProvider["snapshot$"]["value"]>
  >(async () => snapshot);
  const addEventListener = vi.fn(() => removeListener);
  const client = { request, addEventListener } as unknown as GatewayBrowserClient;
  pane.state.sessionKey = params.sessionKey;
  pane.state.client = client;
  Reflect.set(pane, "boardProviderLifecycleConnected", params.lifecycleConnected ?? true);
  pane.context = {
    ...pane.context,
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: {
          ...(params.scopes ? { auth: { role: "operator", scopes: params.scopes } } : {}),
          features: {
            methods: params.methods ?? ["board.get"],
            ...(params.capabilities ? { capabilities: params.capabilities } : {}),
          },
        },
      },
    },
  } as unknown as ApplicationContext;
  pane.context.connectionBootstrap.synchronize({ client, connected: true });
  return { pane, snapshot, client, request, addEventListener, removeListener };
}

function configureGatewayMainSession(pane: TestChatPane, defaultAgentId: string, mainKey: string) {
  pane.context.gateway.snapshot.hello = {
    snapshot: {
      sessionDefaults: {
        defaultAgentId,
        mainKey,
        mainSessionKey: `agent:${defaultAgentId}:${mainKey}`,
      },
    },
  } as ApplicationContext["gateway"]["snapshot"]["hello"];
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  window.history.replaceState({}, "", "/");
  const settings = loadSettings();
  theme = createApplicationTheme(settings, createGatewayStoreTestStore({ settings }).gateway);
});

afterEach(() => {
  theme.dispose();
  vi.restoreAllMocks();
  saveSettings(loadSettings());
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("chat pane board shell", () => {
  it.each(["global"])(
    "keeps an explicitly closed empty dashboard closed when its first content arrives (%s)",
    async (sessionKey) => {
      const { pane, request } = createGatewayBoardPane({ sessionKey });
      pane.routeFace = "chat";
      pane.onFaceChange = vi.fn();
      if (sessionKey === "global") {
        pane.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
        pane.state.assistantAgentId = "work";
      }
      const snapshotKey = sessionKey === "global" ? "agent:work:global" : sessionKey;
      request.mockResolvedValue({ sessionKey: snapshotKey, revision: 1, tabs: [], widgets: [] });
      const provider = pane.resolveBoardProvider();
      try {
        await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
        pane.syncRetainedBoardSession(pane.resolveBoardView());
        const closed = closeSlot(openSlot({ columns: [] }, "dashboard"), "dashboard");
        pane.commitSidebarLayout(closed);
        patchSettings({ sidebarSessionLayouts: { [sessionKey]: closed } });
        request.mockResolvedValue({
          sessionKey: snapshotKey,
          revision: 2,
          tabs: [{ tabId: "main", title: "Overview", position: 0, chatDock: "right" }],
          widgets: [],
        });
        await provider.applyOps([{ kind: "tab_create", tabId: "main", title: "Overview" }]);
        pane.syncRetainedBoardSession(pane.resolveBoardView());
        expect(pane.state.sidebarLayout).toEqual(closed);
        expect(pane.onFaceChange).not.toHaveBeenCalled();
      } finally {
        (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
      }
    },
  );

  it("opens split view once when the current task first gains a dashboard", async () => {
    const pane = createTestPane(undefined, "agent:main:first-dashboard");
    const provider = createMockBoardProvider("agent:main:first-dashboard");
    pane.boardProvider = provider;
    pane.routeFace = "chat";
    pane.onFaceChange = vi.fn();
    await provider.applyOps([
      { kind: "widget_remove", name: "session-status" },
      { kind: "widget_remove", name: "recent-findings" },
      { kind: "widget_remove", name: "source-map" },
      { kind: "tab_delete", tabId: "main" },
      { kind: "tab_delete", tabId: "research" },
    ]);
    pane.syncRetainedBoardSession(pane.resolveBoardView());

    await provider.applyOps([{ kind: "tab_create", tabId: "main", title: "Dashboard" }]);
    pane.syncRetainedBoardSession(pane.resolveBoardView());

    expect(
      pane.state.sidebarLayout.columns.flatMap((column) =>
        column.panels.map((panel) => panel.slot),
      ),
    ).toContain("dashboard");
    expect(pane.state.sidebarLayout.expanded).toBe(false);
    expect(pane.onFaceChange).toHaveBeenCalledOnce();

    pane.syncRetainedBoardSession(pane.resolveBoardView());
    expect(pane.onFaceChange).toHaveBeenCalledOnce();
  });

  it("publishes conversation presentation per pane without overwriting shared session state", () => {
    const first = createTestPane();
    const second = createTestPane();
    second.state = first.state;
    const provider = createMockBoardProvider(first.state.sessionKey);
    first.boardProvider = provider;
    second.boardProvider = provider;
    const changed = vi.fn();
    first.addEventListener("openclaw-chat-pane-lifecycle-changed", changed);
    first.commitRender();
    second.commitRender();
    expect(first.conversationPresented).toBe(true);
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledOnce();

    first.visuallyPresented = false;
    expect(first.conversationPresented).toBe(false);
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    first.presented = false;
    first.visuallyPresented = true;
    expect(first.conversationPresented).toBe(false);
    first.commitRender();
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it.each(["terminal", "dashboard"] as const)(
    "applies a focused dashboard link over saved %s main only once",
    (slot) => {
      const pane = createTestPane(undefined, "agent:main:expanded-route");
      Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
      pane.boardProvider = createMockBoardProvider("agent:main:expanded-route");
      pane.routeFace = "dashboard";
      pane.dashboardExpanded = true;
      const savedLayout = {
        ...promoteSidebarPanel(openSlot({ columns: [] }, slot), slot),
        open: false,
      };
      pane.state.sidebarLayout = savedLayout;
      patchSettings({ sidebarSessionLayouts: { [pane.sessionKey]: savedLayout } });
      Object.defineProperty(pane, "isConnected", { configurable: true, value: true });

      pane.prepareRender();
      pane.commitRender();
      expect(pane.conversationPresented).toBe(false);
      expect(pane.state.sidebarLayout.expanded).toBe(true);
      expect(pane.state.sidebarLayout.open).toBe(true);
      expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
      expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe(
        slot === "dashboard" ? "conversation" : "terminal",
      );

      pane.state.sidebarLayout = { ...pane.state.sidebarLayout, expanded: false };
      pane.prepareRender();
      pane.commitRender();
      expect(pane.state.sidebarLayout.expanded).toBe(false);
      expect(pane.conversationPresented).toBe(slot === "dashboard");
    },
  );

  it("restores a closed saved task layout on an ordinary dashboard revisit", () => {
    const pane = createTestPane(undefined, "agent:main:saved-dashboard-layout");
    pane.boardProvider = createMockBoardProvider(pane.sessionKey);
    pane.routeFace = "dashboard";
    pane.onFaceChange = vi.fn();
    const savedLayout = {
      ...setSidebarDock(
        promoteSidebarPanel(
          openSlot(openSlot({ columns: [] }, "dashboard"), "terminal"),
          "terminal",
        ),
        "left",
      ),
      open: false,
    };
    pane.state.sidebarLayout = savedLayout;
    patchSettings({ sidebarSessionLayouts: { [pane.sessionKey]: savedLayout } });

    pane.syncRetainedBoardSession(pane.resolveBoardView());

    expect(pane.state.sidebarLayout).toEqual(savedLayout);
    expect(pane.onFaceChange).not.toHaveBeenCalled();
  });

  it("does not hydrate the swarm after becoming hidden during module loading", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ sessions: [] });
    const sessions = { canonicalListRevision: 0, list } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.context = {
      ...pane.context,
      runtimeConfig: {
        state: { configSnapshot: { config: {} } },
      },
    } as unknown as ApplicationContext;
    pane.presentedChanged = () => undefined;

    try {
      pane.refreshSwarmRoster();
      await swarmModuleImport.started;
      pane.presented = false;
      swarmModuleImport.release();
      await import("../../lib/sessions/swarm-roster.ts");
      await Promise.resolve();
      await vi.runAllTimersAsync();

      expect(list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps generic child roster hydration available with default swarm configuration", async () => {
    vi.useFakeTimers();
    swarmModuleImport.release();
    const { SwarmRosterHydrator } = await import("../../lib/sessions/swarm-roster.ts");
    const pane = createTestPane({
      canonicalListRevision: 0,
      list: vi.fn(async () => ({ sessions: [] })),
    } as unknown as SessionCapability);
    const configSnapshot = { config: {} };
    pane.context = {
      ...pane.context,
      runtimeConfig: {
        state: {
          configSnapshot,
        },
      },
    } as unknown as ApplicationContext;
    await vi.dynamicImportSettled();

    try {
      for (let index = 0; index < 3; index += 1) {
        pane.refreshSwarmRoster();
      }
      await vi.dynamicImportSettled();

      expect(pane.swarm.hydrator).toBeInstanceOf(SwarmRosterHydrator);
      expect(pane.swarm.enabled).toBe(true);

      const hydrator = pane.swarm.hydrator;
      const enabled = !pane.swarm.enabled;
      configSnapshot.config = { tools: { swarm: { enabled } } };
      pane.refreshSwarmRoster();
      await vi.dynamicImportSettled();

      expect(pane.swarm.hydrator).toBe(hydrator);
      expect(pane.swarm.enabled).toBe(enabled);
    } finally {
      pane.swarm.hydrator?.dispose();
      vi.useRealTimers();
    }
  });

  it("resets a board-bearing session in place so its dashboard stays", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    pane.state.client = client;
    pane.context = {
      ...pane.context,
      gateway: { snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() } },
    } as unknown as ApplicationContext;
    pane.connectedClient = client;
    pane.boardProvider = createMockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(true);
    expect(reset).toHaveBeenCalledWith("agent:main:current", {});
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("rechecks reset scope after board confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.boardProvider = createMockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(pane.state.lastError).toContain("operator.admin");
    expect(pane.state.chatError).toBe(pane.state.lastError);
  });

  it("does not reset when a run starts during confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = createMockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.chatRunId = "run-started-during-confirmation";
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("cancels New Chat when the selected session changes during confirmation", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset: vi.fn(async () => "completed" as const),
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = createMockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.sessionKey = "agent:main:other";
    pane.commitRender();

    await expect(pending).resolves.toBe(false);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.reset).not.toHaveBeenCalled();
  });

  it("does not share reset confirmation across sessions", async () => {
    const pane = createTestPane();
    pane.boardProvider = createMockBoardProvider("agent:main:first");
    pane.state.sessionKey = "agent:main:first";

    const first = pane.confirmConversationReset();
    pane.state.sessionKey = "agent:main:second";
    pane.boardProvider = createMockBoardProvider("agent:main:second");
    const second = pane.confirmConversationReset();

    await expect(first).resolves.toBe(false);
    pane.settleResetConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it("keeps global dashboard reset confirmation open until its owner changes", async () => {
    const { pane, request } = createGatewayBoardPane({ sessionKey: "global" });
    pane.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    pane.state.assistantAgentId = "work";
    request.mockResolvedValue({
      sessionKey: "agent:work:global",
      revision: 1,
      tabs: [{ tabId: "overview", title: "Work", position: 0, chatDock: "right" }],
      widgets: [],
    });
    try {
      const provider = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));
      const pending = pane.confirmConversationReset();
      pane.commitRender();
      pane.state.assistantAgentId = "main";
      pane.commitRender();
      await expect(pending).resolves.toBe(false);
    } finally {
      pane.settleResetConfirmation(false);
      (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
    }
  });

  it.each(["confirm", "cancel", "dismiss"] as const)(
    "settles board reset from the %s control",
    async (action) => {
      installDialogPolyfill();
      const pane = createTestPane();
      pane.boardProvider = createMockBoardProvider(pane.state.sessionKey);
      const mounted = mountSolid(() => {
        projectChatFields(pane.resetConfirmation);
        return (
          <Show when={pane.renderResetConfirmation()}>
            {(current) => <ChatBoardResetConfirmation {...current()} />}
          </Show>
        );
      });
      expect(mounted.container.querySelector("openclaw-modal-dialog")).toBeNull();
      const pending = pane.confirmConversationReset();
      flush();
      try {
        const modal = mounted.container.querySelector("openclaw-modal-dialog")!;
        if (action === "dismiss") {
          modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
        } else {
          modal
            .querySelector<HTMLButtonElement>(
              action === "confirm" ? "button.primary" : "button:not(.primary)",
            )!
            .click();
        }
        await expect(pending).resolves.toBe(action === "confirm");
        expect(pane.resetConfirmation.pending).toBeUndefined();
        flush();
        expect(mounted.container.querySelector("openclaw-modal-dialog")).toBeNull();
      } finally {
        pane.settleResetConfirmation(false);
        mounted.unmount();
      }
    },
  );

  it("keeps chat-only reset confirmation disabled", async () => {
    const pane = createTestPane();
    pane.boardProvider = boardProviderForSession({ sessionKey: "agent:main:current" });

    await expect(pane.confirmConversationReset()).resolves.toBe(true);
  });

  it("maps transient Board presentation commands onto the dashboard panel", () => {
    const pane = createTestPane();
    const provider = createMockBoardProvider("agent:main:current");
    pane.boardProvider = provider;
    pane.onFaceChange = vi.fn();
    const unsubscribe = provider.events.subscribe((event) => pane.handleBoardCommand(event));

    provider.emitCommand({ kind: "set_chat_dock", dock: "left" });
    expect(
      pane.state.sidebarLayout.columns.flatMap((column) =>
        column.panels.map((panel) => panel.slot),
      ),
    ).toContain("dashboard");
    expect(pane.state.sidebarLayout.expanded).toBe(false);

    provider.emitCommand({ kind: "set_chat_dock", dock: "hidden" });
    expect(pane.state.sidebarLayout.expanded).toBe(true);
    expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
    expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe("conversation");
    provider.emitCommand({ kind: "set_chat_dock", dock: "right" });
    expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
    expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe("conversation");
    expect(pane.state.sidebarLayout.expanded).toBe(false);
    expect(pane.onFaceChange).toHaveBeenLastCalledWith(pane.paneId, pane.sessionKey, "dashboard");
    unsubscribe();
  });

  it("restores one board view across equivalent main session keys", () => {
    const pane = createTestPane();
    configureGatewayMainSession(pane, "main", "main");
    pane.state.sessionKey = "agent:main:main";
    pane.boardProvider = createMockBoardProvider("main");
    pane.routeFace = "dashboard";
    pane.handleBoardCommand({
      sessionKey: "main",
      command: { kind: "focus_tab", tabId: "research" },
    });

    pane.boardProvider = createMockBoardProvider("agent:main:main");

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });
  });

  it("uses in-memory tab preferences while the route owns the face", () => {
    const pane = createTestPane();
    pane.routeFace = "dashboard";
    pane.boardProvider = createMockBoardProvider("agent:main:current");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    patchSettings({
      boardSessionViews: {
        "agent:main:current": { activeTabId: "research" },
      },
    });

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });

    pane.handleBoardCommand({
      sessionKey: pane.state.sessionKey,
      command: { kind: "focus_tab", tabId: "main" },
    });
    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "main",
      face: "dashboard",
    });
  });

  it("preserves preferences saved by another split pane", () => {
    const initialSettings = patchSettings({
      boardSessionViews: {
        "agent:main:first": { activeTabId: "main" },
      },
    });
    const firstPane = createTestPane();
    firstPane.routeFace = "dashboard";
    firstPane.state.sessionKey = "agent:main:first";
    firstPane.state.settings = initialSettings;
    firstPane.boardProvider = createMockBoardProvider("agent:main:first");
    const secondPane = createTestPane();
    secondPane.routeFace = "dashboard";
    secondPane.state.sessionKey = "agent:main:second";
    secondPane.state.settings = initialSettings;
    secondPane.boardProvider = createMockBoardProvider("agent:main:second");

    firstPane.handleBoardCommand({
      sessionKey: firstPane.state.sessionKey,
      command: { kind: "focus_tab", tabId: "research" },
    });

    secondPane.state.sessionKey = "agent:main:first";
    secondPane.boardProvider = createMockBoardProvider("agent:main:first");
    expect(secondPane.resolveBoardView()).toMatchObject({
      face: "dashboard",
      activeTabId: "research",
    });

    secondPane.state.sessionKey = "agent:main:second";
    secondPane.boardProvider = createMockBoardProvider("agent:main:second");
    secondPane.handleBoardCommand({
      sessionKey: secondPane.state.sessionKey,
      command: { kind: "focus_tab", tabId: "main" },
    });

    expect(loadSettings().boardSessionViews).toMatchObject({
      "agent:main:first": { activeTabId: "research" },
      "agent:main:second": { activeTabId: "main" },
    });
  });

  it("resolves configured main aliases before selecting a provider", () => {
    const pane = createTestPane();
    pane.state.sessionKey = "primary";
    configureGatewayMainSession(pane, "work", "primary");

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe("agent:work:primary");
  });

  it("keeps the board and its iframe connected when a retained pane hides and returns", () => {
    const pane = createTestPane();
    pane.boardProvider = createMockBoardProvider(pane.state.sessionKey);
    const container = document.body.appendChild(document.createElement("div"));
    const layout = openSlot({ columns: [] }, "dashboard");
    const mounted = mountBoardPanel(pane, layout, container);
    const draw = () => mounted.draw();
    try {
      pane.visuallyPresented = true;
      draw();
      const board = container.querySelector("openclaw-board-view")!;
      const frame = board.appendChild(document.createElement("iframe"));
      for (const visible of [false, true]) {
        pane.visuallyPresented = visible;
        draw();
        expect(container.querySelector("openclaw-board-view")).toBe(board);
        expect(frame.isConnected).toBe(true);
        expect(board.active).toBe(visible);
      }
    } finally {
      mounted.unmount();
      container.remove();
    }
  });

  it.each([{ key: "notes", acknowledged: "agent:research:notes", globalScope: false }])(
    "passes the admitted board owner to widgets while retaining $key",
    async ({ key, acknowledged, globalScope }) => {
      const { pane, request } = createGatewayBoardPane({ sessionKey: key });
      pane.state.assistantAgentId = "research";
      pane.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: globalScope ? "global" : "per-sender",
        agents: [],
      };
      const snapshot = { sessionKey: acknowledged, revision: 1, tabs: [], widgets: [] };
      request.mockResolvedValue(snapshot);
      const container = document.createElement("div");
      const layout = openSlot({ columns: [] }, "dashboard");
      const mounted = mountBoardPanel(pane, layout, container);
      const draw = () => mounted.draw();
      const target = () =>
        (
          container.querySelector("openclaw-board-view") as
            | (HTMLElement & { session: { sessionKey: string; agentId?: string } })
            | null
        )?.session;
      try {
        const provider = pane.resolveBoardProvider();
        await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
        draw();
        expect(target()).toEqual({ sessionKey: key, agentId: "research" });
        expect(request).toHaveBeenCalledWith("board.get", {
          sessionKey: key,
          ...(key === "notes" ? {} : { agentId: "research" }),
        });
        if (key === "notes") {
          let complete!: (value: typeof snapshot) => void;
          request.mockReturnValueOnce(
            new Promise((resolve) => {
              complete = resolve;
            }),
          );
          pane.state.sessionKey = "replacement-notes";
          const replacement = pane.resolveBoardProvider();
          draw();
          expect(target()).toEqual({ sessionKey: "replacement-notes", agentId: undefined });
          expect(container.querySelector("openclaw-board-view")?.snapshot).toBeUndefined();
          complete({ ...snapshot, sessionKey: "agent:work:replacement-notes" });
          await vi.waitFor(() => expect(replacement.hasLoadedSnapshot).toBe(true));
          draw();
          expect(target()).toEqual({ sessionKey: "replacement-notes", agentId: "work" });
        }
      } finally {
        mounted.unmount();
        (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
      }
    },
  );

  it("keeps global board leases scoped through owner switches, second panes, and acknowledgments", async () => {
    const { pane, client, request, addEventListener, removeListener } = createGatewayBoardPane({
      sessionKey: "agent:main:main",
    });
    const configure = (target: TestChatPane, agentId: string) => {
      target.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      target.state.assistantAgentId = agentId;
      target.state.sessionKey = "global";
    };
    request.mockImplementation(
      async (_method: string, params: { sessionKey: string; agentId?: string }) => ({
        sessionKey:
          params.sessionKey === "global" ? `agent:${params.agentId}:global` : params.sessionKey,
        revision: 1,
        tabs: [
          {
            tabId: "overview",
            title: params.agentId ?? "missing owner",
            position: 0,
            chatDock: "right" as const,
          },
        ],
        widgets: [],
      }),
    );
    configure(pane, "main");
    const second = createTestPane();
    second.context = pane.context;
    second.state.client = client;
    Reflect.set(second, "boardProviderLifecycleConnected", true);
    configure(second, "main");
    const release = (target: TestChatPane) =>
      (Reflect.get(target, "releaseBoardProviderLease") as () => void).call(target);
    try {
      const main = pane.resolveBoardProvider();
      const shared = second.resolveBoardProvider();
      await vi.waitFor(() => expect(main.snapshot$.value.tabs).toHaveLength(1));
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "main",
      });
      expect(shared.snapshot$).toBe(main.snapshot$);
      expect(addEventListener).toHaveBeenCalledTimes(1);

      configure(pane, "work");
      const work = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(work.snapshot$.value.tabs[0]?.title).toBe("work"));
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "work",
      });
      expect(shared.snapshot$.value.tabs[0]?.title).toBe("main");
      expect(work.snapshot$).not.toBe(main.snapshot$);
      expect(pane.resolveBoardProvider()).toBe(work);
      expect(removeListener).not.toHaveBeenCalled();

      release(second);
      expect(removeListener).toHaveBeenCalledTimes(1);
      release(pane);
      expect(removeListener).toHaveBeenCalledTimes(2);
      const reacquired = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(reacquired.snapshot$.value.tabs[0]?.title).toBe("work"));
      expect(reacquired.snapshot$).not.toBe(work.snapshot$);
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "work",
      });
    } finally {
      release(pane);
      release(second);
    }
  });

  it("does not subscribe to a gateway board before the pane owns a lifecycle lease", async () => {
    const sessionKey = "agent:main:board-lifecycle-ownership";
    const { pane, snapshot, request, addEventListener, removeListener } = createGatewayBoardPane({
      sessionKey,
      scopes: ["operator.read", "operator.write"],
      lifecycleConnected: false,
    });

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe(sessionKey);
    expect(request).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();

    Reflect.set(pane, "boardProviderLifecycleConnected", true);
    const provider = pane.resolveBoardProvider();
    try {
      await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
    }

    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("does not reuse another board lease after gateway board support disappears", () => {
    const sessionKey = "agent:main:board-support-revoked";
    const { pane, client, addEventListener } = createGatewayBoardPane({
      sessionKey,
      methods: ["chat.history"],
    });

    const otherConsumer = acquireBoardProviderForSession({ sessionKey }, client);
    try {
      expect(pane.resolveBoardProvider()).toMatchObject({
        canMutate: false,
        canGrant: false,
        canPinWidgets: false,
        canPinMcpApps: false,
      });
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      otherConsumer.release();
    }
  });

  it("enables MCP App pinning only when app-view and put methods are both advertised", () => {
    const cases = [
      { suffix: "put-only", methods: ["board.get", "board.widget.put"], expected: false },
      { suffix: "view-only", methods: ["board.get", "board.widget.appView"], expected: false },
      {
        suffix: "complete",
        methods: ["board.get", "board.widget.appView", "board.widget.put"],
        expected: true,
      },
    ];

    for (const testCase of cases) {
      const { pane } = createGatewayBoardPane({
        sessionKey: `agent:main:${testCase.suffix}`,
        methods: testCase.methods,
      });
      expect(pane.resolveBoardProvider().canPinMcpApps).toBe(testCase.expected);
    }
  });

  it("updates chat authorization without changing another consumer of the same board", async () => {
    const sessionKey = "agent:main:chat-lease-scope-change";
    const features = {
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    };
    const { pane, snapshot, client, request, addEventListener, removeListener } =
      createGatewayBoardPane({
        sessionKey,
        scopes: ["operator.read", "operator.write"],
        methods: features.methods,
        capabilities: features.capabilities,
      });
    const chat = pane.resolveBoardProvider();
    const approvals = acquireBoardProviderForSession(
      { sessionKey },
      client,
      true,
      false,
      false,
      false,
      true,
    );

    try {
      await vi.waitFor(() => expect(chat.snapshot$.value).toEqual(snapshot));
      expect(chat).toMatchObject({
        canPinWidgets: true,
        canPinMcpApps: true,
        canMutate: true,
        canGrant: false,
      });
      expect(approvals.provider).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: true,
      });

      pane.context = {
        ...pane.context,
        gateway: {
          snapshot: {
            client,
            phase: "connected",
            hello: {
              auth: { role: "operator", scopes: ["operator.read"] },
              features,
            },
          },
        },
      } as unknown as ApplicationContext;

      expect(pane.resolveBoardProvider()).toBe(chat);
      expect(chat).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: false,
      });
      expect(approvals.provider.canGrant).toBe(true);
      expect(approvals.provider.canMutate).toBe(false);
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();

      approvals.release();
      expect(removeListener).not.toHaveBeenCalled();
      (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      approvals.release();
      (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
    }
  });

  it("grants board actions to a writer with approval scope", () => {
    const { pane } = createGatewayBoardPane({
      sessionKey: "agent:main:writer-with-approvals",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    });
    const provider = pane.resolveBoardProvider();
    expect(provider.canMutate).toBe(true);
    expect(provider.canGrant).toBe(true);
    expect(provider.canPinWidgets).toBe(true);
    expect(provider.canPinMcpApps).toBe(true);
  });
});
