import { createComponent, createSignal, flush, merge, Show } from "solid-js";
import { onTestFinished, vi } from "vitest";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
} from "../../app/question-prompt.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { mountSolid as mountSolidRoot } from "../../test-helpers/mount-solid.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionContext,
} from "./chat-application-context.test-support.ts";
import { buildChatBoardPanel } from "./chat-pane-board-panel.ts";
import type { ChatBoardPanelSource } from "./chat-pane-panel-source.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createPaneTestHost as createRuntimeTestHost,
  getPaneTestRuntime,
  type PaneRuntimeConstructor,
  type PaneTestLifecycle,
} from "./chat-pane-runtime.test-support.ts";
import { runChatHeaderSessionAction } from "./chat-pane-session-menu-actions.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import type { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import type { ChatTypingActorState } from "./chat-typing-presence.ts";
import type { ChatProps } from "./chat-view.tsx";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";

type PaneHeaderWorkspace = ReturnType<typeof createChatPaneRails>["sessionWorkspace"];

export function createPaneHeaderWorkspaceFixture(
  state: Parameters<typeof createSessionWorkspaceProps>[0],
): PaneHeaderWorkspace {
  return {
    ...createSessionWorkspaceProps(state),
    collapsed: true,
    onToggleCollapsed: vi.fn(),
    onToggleTerminal: undefined,
    onToggleBrowser: undefined,
    onToggleDesktop: undefined,
  };
}

type BoardPanelProps = Parameters<typeof ChatBoardPanel>[0];

export function mountBoardPanel(
  pane: {
    resolveBoardView: () => ResolvedBoardView;
    boardPanelSource: (
      board: ResolvedBoardView,
      layout: ChatPageHost["sidebarLayout"],
    ) => ChatBoardPanelSource | null;
  },
  layout: ChatPageHost["sidebarLayout"],
  container: HTMLElement,
) {
  const [content, setContent] = createSignal<BoardPanelProps | null>(null);
  const view = mountSolidRoot(
    () =>
      Show({
        get when() {
          return content();
        },
        children: (current) => createComponent(ChatBoardPanel, merge(current)),
      }),
    { container },
  );
  return {
    ...view,
    draw: () => {
      const source = pane.boardPanelSource(pane.resolveBoardView(), layout);
      setContent(source ? buildChatBoardPanel(source) : null);
      flush();
    },
  };
}

// The proxy forwards public runtime members; only protected test access needs declarations.
export type TestChatPane = HTMLElement &
  PaneTestLifecycle &
  Omit<Pick<ChatPaneRuntime, keyof ChatPaneRuntime>, "chatState" | "state"> & {
    chatState: Pick<
      ReturnType<typeof createChatState<ChatPageHost>>,
      "attach" | "composerDraft" | "composerPersistence" | "createRenderLifecycle"
    >;
    state: ChatPageHost;
    connectedClient: GatewayBrowserClient | null;
    applyGatewaySnapshot: (snapshot: ApplicationContext["gateway"]["snapshot"]) => void;
    catalogLoadGeneration: number;
    continueCatalogSession: ChatPaneRuntime["continueCatalogSession"];
    forkFromMessage: (entryId: string) => Promise<void>;
    createSession: () => Promise<boolean>;
    recoverSession: () => Promise<boolean>;
    restartRecoveryComposerBanner: ChatPaneRuntime["restartRecoveryComposerBanner"];
    restoreArchivedSession: (sessionKey: string, expectedSessionId: string) => Promise<void>;
    resolveTaskSuggestion: ChatPaneRuntime["resolveTaskSuggestion"];
    copyTaskSuggestionPrompt: ChatPaneRuntime["copyTaskSuggestionPrompt"];
    handleDocumentKeydown: (event: KeyboardEvent) => void;
    handleTaskSuggestionEvent: ChatPaneRuntime["handleTaskSuggestionEvent"];
    refreshTaskSuggestions: () => Promise<void>;
    refreshSessionPullRequests: (options?: { refresh?: boolean; automatic?: boolean }) => boolean;
    sessionPullRequests: ControlUiSessionPullRequest[];
    sessionPullRequestsBranch: ControlUiSessionBranch | undefined;
    suggestionChatProps: ChatPaneRuntime["suggestionChatProps"];
    addCurrentSessionSuggestion: () => Promise<void>;
    resetSessionSuggestions: () => void;
    sessionSuggestionsRefreshPromise: Promise<void> | undefined;
    sessionSuggestionTargetSignature: string;
    syncSessionSuggestionTarget: (agentId: string, session: GatewaySessionRow | undefined) => void;
    handleSessionSuggestionEvent: ChatPaneRuntime["handleSessionSuggestionEvent"];
    handleSessionTypingEvent: ChatPaneRuntime["handleSessionTypingEvent"];
    clearTypingActorForSessionMessage: (payload: unknown) => void;
    pruneTypingActors: () => void;
    typingActors: Map<string, ChatTypingActorState>;
    clearTypingActors: () => void;
    sendTypingState: (typing: boolean, preview?: string, cursor?: number) => void;
    refreshSessionSuggestions: () => Promise<void>;
    resolveCurrentSessionSuggestion: ChatPaneRuntime["resolveCurrentSessionSuggestion"];
    deferSessionHydrationUntilTranscript: ChatPaneRuntime["deferSessionHydrationUntilTranscript"];
    catalogItemMessage: ChatPaneRuntime["catalogItemMessage"];
    handleTranscriptScroll: (event: Event) => void;
    handleTranscriptHistoryIntent: (event: Event) => void;
    historyAutoLoadBlocked: boolean;
    historyObserverArmed: boolean;
    transcriptScrollTop: number | null;
    syncHistoryObserver: () => void;
    loadCatalogSession: ChatPaneRuntime["loadCatalogSession"];
    prependUniqueCatalogMessages: (messages: unknown[]) => unknown[];
    loadOlderMessages: (readerIntent?: boolean) => Promise<boolean>;
    resetOlderMessagesViewport: () => void;
    readReplyMessage: (messageId: string) => unknown;
    hasOlderMessages: () => boolean;
    cancelHeaderRename: () => void;
    commitHeaderRename: () => void;
    handleHeaderMenuAction: ChatPaneRuntime["handleHeaderMenuAction"];
    loadHeaderMenuData: ChatPaneRuntime["loadHeaderMenuData"];
    markSessionRead: (row: GatewaySessionRow | undefined) => void;
    applySessionsState: (stateValue: ApplicationContext["sessions"]["state"]) => void;
    renderPaneHeader: ChatPaneRuntime["renderPaneHeader"];
  };

export function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

export function createPaneTestHost<R extends ChatPaneRuntime>(
  tag: string,
  Runtime: PaneRuntimeConstructor<R>,
) {
  return createRuntimeTestHost(tag, Runtime, createInitializationContext);
}

export { getPaneTestRuntime, connectPaneTestView } from "./chat-pane-runtime.test-support.ts";

export function createTestChatPane(
  params: {
    client?: GatewayBrowserClient;
    sessions?: SessionCapability;
  } = {},
) {
  const client = params.client ?? createGatewayBrowserClientFixture();
  if (params.sessions) {
    // Panes sharing a synthetic capability must keep the same owner and live getters.
    const defaults = Object.getOwnPropertyDescriptors(
      createSessionCapabilityFixture(params.sessions),
    );
    for (const [key, descriptor] of Object.entries(defaults)) {
      if (!(key in params.sessions)) {
        Object.defineProperty(params.sessions, key, descriptor);
      }
    }
  }
  const context = createSessionContext(client, params.sessions);
  // SAFETY: TestChatPane declares the protected controller surface forwarded by the test host.
  const pane = createPaneTestHost(
    "openclaw-chat-runtime-test",
    ChatPaneRuntime,
  ) as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", {
    configurable: true,
    value: true,
  });
  pane.context = context;
  const renderLifecycle = pane.chatState.createRenderLifecycle();
  const chatMessagesBySession: ChatMessageCache = new Map();
  const state: ChatPageHost = Object.assign(
    createPageState(
      context,
      renderLifecycle,
      {
        sessionKey: "agent:main:current",
        dispatchEvent: (event) => pane.element.dispatchEvent(event),
      },
      chatMessagesBySession,
    ),
    {
      agentsList: null,
      assistantAgentId: null,
      client,
      connected: true,
      connectionEpoch: 4,
      hello: sessionMutationGatewayHello(),
      sidebarLayout: { columns: [] },
      // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
      handleChatScroll: vi.fn(),
      resetToolStream: vi.fn(),
    },
  );
  state.updateSidebarLayout = (layout) => {
    state.sidebarLayout = layout;
  };
  state.updateSidebarActivePanel = () => {};
  pane.state = state;
  pane.chatState.attach(state);
  pane.connectedClient = client;
  pane.connectionGeneration = 4;
  const applyGatewaySnapshot = pane.applyGatewaySnapshot.bind(pane);
  let publishingSnapshot = false;
  let paneReceivedSnapshot = false;
  vi.spyOn(pane, "applyGatewaySnapshot").mockImplementation((snapshot) => {
    if (publishingSnapshot) {
      paneReceivedSnapshot = true;
      applyGatewaySnapshot(snapshot);
      return;
    }
    publishingSnapshot = true;
    paneReceivedSnapshot = false;
    try {
      // Direct pane calls must notify capability owners first. A mounted pane's
      // subscription already delivers the snapshot, so do not deliver it twice.
      context.publishGatewaySnapshot(snapshot);
      if (!paneReceivedSnapshot) {
        applyGatewaySnapshot(snapshot);
      }
    } finally {
      publishingSnapshot = false;
    }
  });
  onTestFinished(async () => {
    pane.disconnectedCallback();
    // Let lazy pane imports observe disconnect before Vitest removes their environment.
    await vi.dynamicImportSettled();
  });
  return {
    pane,
    sessions: context.sessions,
    state,
    emitGatewayEvent: (event: string, payload: unknown) => {
      const emit = (
        pane.context.gateway as ApplicationContext["gateway"] & {
          emitTestEvent: (event: GatewayEventFrame) => void;
        }
      ).emitTestEvent;
      emit({ type: "event", event, payload, seq: 1 });
    },
  };
}

export function runPaneHeaderAction(
  pane: TestChatPane,
  action: Parameters<typeof runChatHeaderSessionAction>[1],
  row: GatewaySessionRow,
) {
  return runChatHeaderSessionAction(getPaneTestRuntime(pane), action, row);
}

type ActivePlacement = Extract<NonNullable<GatewaySessionRow["placement"]>, { state: "active" }>;

export function activePlacementSession(
  key = "agent:main:cloud",
): GatewaySessionRow & { placement: ActivePlacement } {
  return {
    key,
    kind: "direct",
    updatedAt: 0,
    placement: createActiveSessionPlacement({
      environmentId: "worker:one",
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
    }),
  };
}

export function offlineDeviceSession(): GatewaySessionRow & { placement: ActivePlacement } {
  const session = activePlacementSession("agent:main:offline-device");
  return {
    ...session,
    hasActiveRun: true,
    placement: {
      ...session.placement,
      runner: { kind: "device", status: "offline" },
    },
  };
}

class RenderTestChatPane extends ChatPaneRuntime {
  declare context: ApplicationContext;
  chatProps: ChatProps | undefined;

  constructor(element: HTMLElement, context: ApplicationContext) {
    super(element, context);
    onTestFinished(() => disposeQuestionPromptState(this.questionPromptState));
  }

  receiveQuestionEvent(event: Pick<GatewayEventFrame, "event" | "payload">) {
    handleQuestionPromptEvent(this.questionPromptState, event);
  }

  initialize(context: ApplicationContext) {
    this.context = context;
    this.state = createPageState(
      context,
      { afterCommit: () => () => {} },
      {
        sessionKey: this.sessionKey,
        dispatchEvent: (event) => this.element.dispatchEvent(event),
      },
    );
    return this.state;
  }

  protected override renderChatPaneLayout(params: { chatProps: ChatProps }) {
    this.chatProps = params.chatProps;
    return null;
  }

  override applySessionsState(state: ApplicationContext["sessions"]["state"]) {
    super.applySessionsState(state);
  }

  override refreshSessionPullRequests(options: { refresh?: boolean; automatic?: boolean } = {}) {
    return super.refreshSessionPullRequests(options);
  }
}

export function createRenderTestChatPane() {
  return createPaneTestHost("openclaw-chat-render-regression", RenderTestChatPane);
}
