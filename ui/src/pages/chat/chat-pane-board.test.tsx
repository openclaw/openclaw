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
  createNullBoardProvider,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createPaneTestHost, getPaneTestRuntime } from "./chat-pane-runtime.test-support.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import { ChatBoardResetConfirmation } from "./chat-pane-surfaces.tsx";
import { mountBoardPanel } from "./chat-pane.test-support.ts";
import { createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { closeSlot, openSlot } from "./sidebar-layout.ts";

// mock-isolation: isolate board data and presentation without registering the real board renderer.
vi.mock("../../components/board/board-view.tsx", () => {
  if (!customElements.get("openclaw-board-view")) {
    customElements.define("openclaw-board-view", class extends HTMLElement {});
  }
  return {
    BoardView: (
      props: Parameters<typeof import("../../components/board/board-view.tsx").BoardView>[0],
    ) => (
      <openclaw-board-view
        ref={props.ref}
        prop:active={props.active}
        prop:session={props.session}
        prop:snapshot={props.snapshot}
      />
    ),
  };
});

const swarmModuleImport = await vi.hoisted(async () => {
  const { createDeferred } = await import("../../../../test/helpers/promise.js");
  return { started: createDeferred(), pending: createDeferred() };
});

vi.mock("../../lib/sessions/swarm-roster.ts", async (importOriginal) => {
  swarmModuleImport.started.resolve();
  await swarmModuleImport.pending.promise;
  return importOriginal();
});

type TestChatPane = HTMLElement & {
  boardProvider?: BoardProvider;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  state: ChatPageHost;
  createSession: () => Promise<boolean>;
  presented: boolean;
  visuallyPresented: boolean;
  readonly conversationPresented: boolean;
  presentedChanged: (presented: boolean) => void;
  sessionKey: string;
  resetConfirmation: { pending: object | undefined };
  routeFace: "chat" | "dashboard";
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  confirmConversationReset: () => Promise<boolean>;
  commitSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
  settleResetConfirmation: (confirmed: boolean) => void;
  commitRender: () => void;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => ResolvedBoardView;
  renderBoardPanel: Parameters<typeof mountBoardPanel>[0]["renderBoardPanel"];
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
  pane.sessionKey = sessionKey;
  pane.state = {
    ...createInitialChatRealtimeState(),
    chatError: null,
    chatLoading: false,
    chatHistoryPagination: { hasMore: false },
    chatMessages: [],
    chatMessagesBySession: new Map(),
    settings: loadSettings(),
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
    sidebarLayout: { columns: [] },
    sessions,
    sessionsError: null,
    sessionsLoading: false,
  } as unknown as ChatPageHost;
  pane.state.updateSidebarLayout = (layout) => {
    pane.state.sidebarLayout = layout;
  };
  pane.state.updateSidebarActivePanel = () => {};
  pane.connectedClient = client;
  pane.connectionGeneration = 1;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  return pane;
}

function configureAgent(
  pane: TestChatPane,
  agentId: string,
  scope: "global" | "per-sender" = "global",
) {
  pane.state.agentsList = { defaultId: "main", mainKey: "main", scope, agents: [] };
  pane.state.assistantAgentId = agentId;
}

function boardSnapshot(sessionKey: string, title?: string, revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: title ? [{ tabId: "main", title, position: 0, chatDock: "right" as const }] : [],
    widgets: [],
  };
}

function createGatewayBoardPane(params: {
  sessionKey: string;
  methods?: readonly string[];
  scopes?: readonly string[];
  capabilities?: readonly string[];
  lifecycleConnected?: boolean;
}) {
  const pane = createTestPane(undefined, params.sessionKey);
  const snapshot = boardSnapshot(params.sessionKey);
  const removeListener = vi.fn();
  const request = vi.fn<
    (
      method: string,
      params: { sessionKey: string; agentId?: string },
    ) => Promise<BoardProvider["snapshot$"]["value"]>
  >(async () => snapshot);
  const addEventListener = vi.fn(() => removeListener);
  const client = { request, addEventListener } as unknown as GatewayBrowserClient;
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
  onTestFinished(() => releaseBoard(pane));
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

function resetPane() {
  const reset = vi.fn(async () => "completed" as const);
  const sessions = {
    create: vi.fn(async () => "agent:main:new"),
    reset,
  } as unknown as SessionCapability;
  const pane = createTestPane(sessions);
  pane.boardProvider = createMockBoardProvider(pane.sessionKey);
  return { pane, sessions, reset };
}

function releaseBoard(pane: TestChatPane) {
  (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
}

function slots(pane: TestChatPane) {
  return pane.state.sidebarLayout.columns.flatMap((column) =>
    column.panels.map((panel) => panel.slot),
  );
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
  it("keeps an explicitly closed empty global dashboard closed when its first content arrives", async () => {
    const sessionKey = "global";
    const { pane, request } = createGatewayBoardPane({ sessionKey });
    pane.routeFace = "chat";
    pane.onFaceChange = vi.fn();
    configureAgent(pane, "work");
    const snapshotKey = "agent:work:global";
    request.mockResolvedValue(boardSnapshot(snapshotKey));
    const provider = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
    pane.syncRetainedBoardSession(pane.resolveBoardView());
    const closed = closeSlot(openSlot({ columns: [] }, "dashboard"), "dashboard");
    pane.commitSidebarLayout(closed);
    patchSettings({ sidebarSessionLayouts: { [sessionKey]: closed } });
    request.mockResolvedValue(boardSnapshot(snapshotKey, "Overview", 2));
    await provider.applyOps([{ kind: "tab_create", tabId: "main", title: "Overview" }]);
    pane.syncRetainedBoardSession(pane.resolveBoardView());
    expect(pane.state.sidebarLayout).toEqual(closed);
    expect(pane.onFaceChange).not.toHaveBeenCalled();
  });

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

    expect(slots(pane)).toContain("dashboard");
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

  it("ignores retired swarm imports and keeps hidden panes unhydrated", async () => {
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
    const retired = createTestPane(sessions);
    const replaced = createTestPane(sessions);
    const retiredAdmission = vi.spyOn(retired.context.connectionBootstrap, "run");
    const replacedAdmission = vi.spyOn(replaced.context.connectionBootstrap, "run");

    try {
      pane.refreshSwarmRoster();
      retired.refreshSwarmRoster();
      replaced.refreshSwarmRoster();
      await swarmModuleImport.started.promise;
      pane.presented = false;
      ChatPaneStateOwner.prototype.dispose.call(getPaneTestRuntime(retired));
      replaced.context = { ...replaced.context };
      swarmModuleImport.pending.resolve();
      await import("../../lib/sessions/swarm-roster.ts");
      await Promise.resolve();
      await vi.runAllTimersAsync();

      expect(list).not.toHaveBeenCalled();
      expect(retiredAdmission).not.toHaveBeenCalled();
      expect(replacedAdmission).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a disposed pane's held roster refresh before the foreground becomes ready", async () => {
    swarmModuleImport.pending.resolve();
    const pane = createTestPane();
    const runtime = getPaneTestRuntime(pane);
    const bootstrap = pane.context.connectionBootstrap;
    bootstrap.setForegroundRoute("agent:main:pending");
    pane.refreshSwarmRoster();
    await vi.dynamicImportSettled();
    const settled = bootstrap.run(runtime, async () => {});

    ChatPaneStateOwner.prototype.dispose.call(runtime);
    await settled;

    expect(bootstrap.foregroundReady).toBe(false);
  });

  it("resets a board-bearing session in place so its dashboard stays", async () => {
    const { pane, sessions, reset } = resetPane();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    pane.state.client = client;
    pane.context.gateway.snapshot.client = client;
    pane.connectedClient = client;

    const pending = pane.createSession();
    await Promise.resolve();
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(true);
    expect(reset).toHaveBeenCalledWith("agent:main:current", {});
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("rechecks reset scope after board confirmation", async () => {
    const { pane, reset } = resetPane();
    pane.context.gateway.snapshot.hello!.features = { methods: ["sessions.reset"] };

    const pending = pane.createSession();
    await Promise.resolve();
    pane.context.gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.write"] };
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(pane.state.lastError).toContain("operator.admin");
    expect(pane.state.chatError).toBe(pane.state.lastError);
  });

  it.each(["run starts", "session changes"] as const)(
    "cancels New Chat when %s during confirmation",
    async (change) => {
      const { pane, sessions, reset } = resetPane();
      const pending = pane.createSession();
      await Promise.resolve();
      if (change === "run starts") {
        pane.state.chatRunId = "run-started-during-confirmation";
        pane.settleResetConfirmation(true);
      } else {
        pane.state.sessionKey = "agent:main:other";
        pane.commitRender();
      }
      await expect(pending).resolves.toBe(false);
      expect(reset).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    },
  );

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
    configureAgent(pane, "work");
    request.mockResolvedValue(boardSnapshot("agent:work:global", "Work"));
    onTestFinished(() => pane.settleResetConfirmation(false));
    const provider = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));
    const pending = pane.confirmConversationReset();
    pane.commitRender();
    pane.state.assistantAgentId = "main";
    pane.commitRender();
    await expect(pending).resolves.toBe(false);
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
    pane.boardProvider = createNullBoardProvider("agent:main:current");

    await expect(pane.confirmConversationReset()).resolves.toBe(true);
  });

  it("resolves main aliases while keeping empty providers scoped to their pane and owner", () => {
    const pane = createTestPane();
    configureGatewayMainSession(pane, "work", "primary");
    pane.state.sessionKey = "primary";
    const main = pane.resolveBoardProvider();
    expect(main.snapshot$.value.sessionKey).toBe("agent:work:primary");
    pane.state.sessionKey = "agent:work:primary";
    expect(pane.resolveBoardProvider()).toBe(main);
    expect(createTestPane(undefined, "agent:work:primary").resolveBoardProvider()).not.toBe(main);

    pane.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    pane.state.sessionKey = "global";
    pane.state.assistantAgentId = "main";
    const globalMain = pane.resolveBoardProvider();
    pane.state.assistantAgentId = "work";
    const globalWork = pane.resolveBoardProvider();
    expect(globalWork).not.toBe(globalMain);
    expect(pane.resolveBoardProvider()).toBe(globalWork);
  });

  it("passes the admitted board owner to widgets while retaining notes", async () => {
    const key = "notes";
    const { pane, request } = createGatewayBoardPane({ sessionKey: key });
    configureAgent(pane, "research", "per-sender");
    const snapshot = boardSnapshot("agent:research:notes");
    request.mockResolvedValue(snapshot);
    const container = document.createElement("div");
    const layout = openSlot({ columns: [] }, "dashboard");
    const mounted = mountBoardPanel(pane, layout, container);
    const target = () =>
      (
        container.querySelector("openclaw-board-view") as
          | (HTMLElement & { session: { sessionKey: string; agentId?: string } })
          | null
      )?.session;
    const provider = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
    mounted.draw();
    await waitForSolid(() => expect(target()).toEqual({ sessionKey: key, agentId: "research" }));
    expect(request).toHaveBeenCalledWith("board.get", { sessionKey: key });
    let complete!: (value: typeof snapshot) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    pane.state.sessionKey = "replacement-notes";
    const replacement = pane.resolveBoardProvider();
    mounted.draw();
    expect(target()).toEqual({ sessionKey: "replacement-notes", agentId: undefined });
    expect(container.querySelector("openclaw-board-view")?.snapshot).toBeUndefined();
    complete({ ...snapshot, sessionKey: "agent:work:replacement-notes" });
    await vi.waitFor(() => expect(replacement.hasLoadedSnapshot).toBe(true));
    mounted.draw();
    expect(target()).toEqual({ sessionKey: "replacement-notes", agentId: "work" });
  });

  it("replaces the board when a global pane changes owner", async () => {
    const { pane, request } = createGatewayBoardPane({ sessionKey: "global" });
    request.mockImplementation(async (_method, params) =>
      boardSnapshot(`agent:${params.agentId}:global`, params.agentId),
    );
    configureAgent(pane, "main");
    const main = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(main.snapshot$.value.tabs[0]?.title).toBe("main"));
    configureAgent(pane, "work");
    const work = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(work.snapshot$.value.tabs[0]?.title).toBe("work"));
    expect(work.snapshot$).not.toBe(main.snapshot$);
    expect(pane.resolveBoardProvider()).toBe(work);
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
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));
    expect(request).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledOnce();

    releaseBoard(pane);
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

  it("revokes a held board's write capabilities when the chat loses write scope", async () => {
    const { pane, snapshot } = createGatewayBoardPane({
      sessionKey: "agent:main:chat-lease-scope-change",
      scopes: ["operator.read", "operator.write"],
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    });
    const chat = pane.resolveBoardProvider();
    await vi.waitFor(() => expect(chat.snapshot$.value).toEqual(snapshot));
    expect(chat).toMatchObject({
      canPinWidgets: true,
      canPinMcpApps: true,
      canMutate: true,
      canGrant: false,
    });
    pane.context.gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    expect(pane.resolveBoardProvider()).toBe(chat);
    expect(chat).toMatchObject({
      canPinWidgets: false,
      canPinMcpApps: false,
      canMutate: false,
      canGrant: false,
    });
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
