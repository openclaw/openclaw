import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionSharingRole,
  MessageReactionSummary,
  SessionSuggestion,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { chatInputOwnerForContext, type ChatInputRegion } from "../../app/chat-input-owner.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createQuestionPromptState } from "../../app/question-prompt.ts";
import type { GatewayStatusProps } from "../../components/gateway-status.ts";
import type { SessionPanelToggleSlot } from "../../components/session-panel-toggle-buffer.ts";
import type {
  BoardCommandEvent,
  BoardProvider,
  BoardProviderLease,
} from "../../lib/board/provider.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../lib/presentation.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  readSessionProgressCard,
  sessionProgressCardsForGateway,
} from "../../lib/session-progress-cards.ts";
import type { GitHubPublicationBinding } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  scopedSessionArtifactKey,
} from "../../lib/sessions/session-key.ts";
import type { SwarmRosterHydrator } from "../../lib/sessions/swarm-roster.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.tsx";
import { projectChatFields } from "./chat-field-projection.ts";
import {
  CHAT_PANE_LIFECYCLE_CHANGED_EVENT,
  CHAT_RUN_ACTIVITY_CHANGED_EVENT,
} from "./chat-history-events.ts";
import {
  getAcceptedChatHistorySession,
  getChatHistoryLoadState,
  isChatHistoryRetrying,
} from "./chat-history-state.ts";
import { createMobileSheetScrollFades } from "./chat-mobile-scroll-fades.ts";
import { createChatPaneDiscussionState } from "./chat-pane-discussion-state.ts";
import { createChatPanePresence } from "./chat-pane-presence.ts";
import type { PendingSessionPanelToggle } from "./chat-pane-session-panel-toggle.ts";
import type { ChatPaneConnectionScope, PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import { SessionParticipationTracker } from "./chat-pane-state.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  ChatTypingActorState,
  ChatTypingActorView,
  ChatTypingOverflow,
} from "./chat-typing-presence.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatPaneHeaderAction } from "./components/chat-pane-header.types.ts";
import type { ChatSessionSharingState } from "./components/chat-session-sharing.solid.tsx";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import { createChatTranscript } from "./components/chat-transcript-controller.ts";
import type { ComposerActivityLayout } from "./components/chat-transcript-layout-owner.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
import { canAutoFollowChat, handleChatScrollTakeover } from "./scroll.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SidebarLayout } from "./sidebar-layout-types.ts";

export type ChatPaneInputChanges = {
  sessionKey?: boolean;
  inputRegion?: boolean;
  draft?: boolean;
  focusComposer?: boolean;
  routeResolutionPending?: boolean;
};

/** Synchronous pane facts and domain resources; Solid owns publication and commits. */
export abstract class ChatPaneStateOwner {
  protected readonly mobileScrollFades = createMobileSheetScrollFades();
  readonly presentation = {
    active: false,
    presented: true,
    visuallyPresented: true,
    documentVisible: document.visibilityState !== "hidden",
  };
  updateComplete: Promise<boolean> = Promise.resolve(true);
  awaitDomCommit = (): Promise<boolean> => this.updateComplete;
  isConnected = false;
  headerElement: HTMLElement | null = null;
  historySentinel: HTMLElement | null = null;
  transcriptAnnouncement: HTMLElement | null = null;
  composerShell: HTMLElement | null = null;
  composerFloat: HTMLElement | null = null;
  private composerActivityLayout: ComposerActivityLayout | null = null;
  protected readonly onActivityPillsLayout = (layout: ComposerActivityLayout, detached = false) => {
    if (detached && this.composerActivityLayout?.strip !== layout.strip) {
      return;
    }
    this.composerActivityLayout = detached ? null : layout;
    this.transcript.syncViewportGeometry();
  };
  private registerPaneElement(
    key:
      | "headerElement"
      | "historySentinel"
      | "transcriptAnnouncement"
      | "composerShell"
      | "composerFloat",
  ) {
    return (element: HTMLElement) => {
      this[key] = element;
      if (key === "composerFloat") {
        this.transcript.syncViewportGeometry();
      }
      return () => {
        if (this[key] === element) {
          this[key] = null;
          if (key === "composerFloat") {
            this.transcript.syncViewportGeometry();
          }
        }
      };
    };
  }
  protected readonly registerHeaderElement = this.registerPaneElement("headerElement");
  protected readonly registerHistorySentinel = this.registerPaneElement("historySentinel");
  protected readonly registerTranscriptAnnouncement =
    this.registerPaneElement("transcriptAnnouncement");
  protected readonly registerComposerShell = this.registerPaneElement("composerShell");
  protected readonly registerComposerFloat = this.registerPaneElement("composerFloat");

  protected abstract get usesMobileHost(): boolean;
  abstract synchronizeInputs(changes: ChatPaneInputChanges): void;
  abstract afterRender(focusComposerChanged: boolean): void;
  private paneLifecycleRoot: Element | null = null;
  // The first Solid render initializes hidden panes; later hidden work parks.
  private readonly handleVisibilityChange = () => {
    this.presentation.documentVisible = document.visibilityState !== "hidden";
    if (document.visibilityState !== "hidden") {
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    if (state.chatStreamRenderFrame != null) {
      // Publish before the browser suspends animation frames; the hidden view stays parked.
      chatRunPresentation(state).publish();
    }
    const liveDraft = getChatComposerState(this.presentationId).composerTextarea?.value;
    const draftChanged = liveDraft !== undefined && liveDraft !== state.chatMessage;
    if (draftChanged) {
      // Page suspension can interrupt IME before compositionend; commit the
      // live textarea while visibility change can still reach browser storage.
      state.handleChatDraftChange(liveDraft);
    }
    state.composerDraftChanged?.();
  };
  start() {
    if (this.chatState.disposed) {
      this.chatState = this.mountChatState();
    }
    this.paneLifecycleRoot =
      this.element.closest("openclaw-app-shell") ?? this.element.parentElement;
    this.chatState.addCleanup(listen(document, "visibilitychange", this.handleVisibilityChange));
    this.isConnected = true;
    this.transcript.start();
    this.refreshBoardSubscriptions();
    // Focus ownership hands off draft persistence synchronously, before another input event.
    this.chatState.addCleanup(
      chatInputOwnerForContext(this.context).subscribe(() => this.activeChanged(this.active)),
    );
    this.activeChanged(this.active);
    // Approval publications reconcile live request ownership even when rendering is parked.
    this.chatState.addCleanup(
      this.context.overlays?.subscribe((snapshot) => {
        if (this.state) {
          this.reconcileWaitingApprovalSnapshot(snapshot.approvalQueue);
        }
      }) ?? (() => {}),
    );
    // Configuration publications reconcile the scoped swarm hydrator outside rendering.
    this.chatState.addCleanup(
      this.context.runtimeConfig?.subscribe(() => {
        this.refreshSwarmRoster();
      }) ?? (() => {}),
    );
    this.paneLifecycleRoot?.dispatchEvent(new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT));
  }

  dispose() {
    this.context?.connectionBootstrap.setForegroundPane(this, null);
    this.chatState.dispose();
    this.isConnected = false;
    this.transcript.dispose();
    this.stopBoardSubscriptions?.();
    this.stopBoardSubscriptions = undefined;
    this.boardPresentation.provider = undefined;
    // A removed Home pane cannot bubble its final loading edge. Notify its
    // former shell so background history does not stay blocked on that pane.
    const paneRoot = this.paneLifecycleRoot;
    this.paneLifecycleRoot = null;
    this.conversationVisible = false;
    paneRoot?.dispatchEvent(new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT));
  }

  // Optional inputs need own fields after TypeScript erasure so their first value publishes.
  mcpAppLaunch?: import("../../components/mcp-app-launch.ts").McpAppOpenDetail = undefined;
  paneId = "single";
  paneLabel?: string = undefined;
  presentationId = "single";
  chatMessagesBySession?: ChatMessageCache = undefined;
  sessionSnapshotStore?: SessionSnapshotStore = undefined;
  // Empty means unresolved route data: boot on the page state's default session
  // without canonicalizing until the container supplies a real key.
  sessionKey = "";
  // This session-keyed pane retains its initial skeleton through URL canonicalization.
  routeLoadingSkeleton = false;
  routeResolutionPending = false;
  agentId?: string = undefined;
  inputRegion: ChatInputRegion = "page";
  compact = false;
  onBackToSubagents?: () => void = undefined;
  workContext?: ChatWorkContext = undefined;
  // Route ownership settles after retained-pane preview; dashboard activity follows
  // the pane the user can already see so its warmed runtime paints immediately.
  private conversationVisible = false;
  get visuallyPresented(): boolean {
    return this.presentation.visuallyPresented;
  }
  set visuallyPresented(value: boolean) {
    const previous = this.presentation.visuallyPresented;
    if (value === previous) {
      return;
    }
    const wasConversationPresented = this.conversationPresented;
    this.presentation.visuallyPresented = value;
    this.element.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    this.notifyConversationPresentation(wasConversationPresented);
  }
  /** The pane's committed layout and both visual and route ownership permit idle warming. */
  get conversationPresented(): boolean {
    return this.presented && this.visuallyPresented && this.conversationVisible;
  }
  protected setConversationVisible(visible: boolean): void {
    const wasConversationPresented = this.conversationPresented;
    this.conversationVisible = visible;
    this.notifyConversationPresentation(wasConversationPresented);
  }
  private notifyConversationPresentation(wasPresented: boolean): void {
    if (wasPresented !== this.conversationPresented) {
      this.element.dispatchEvent(
        new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, { bubbles: true, composed: true }),
      );
    }
  }
  private headerPresentationGeneration = 0;
  get presented(): boolean {
    return this.presentation.presented;
  }
  set presented(value: boolean) {
    const previous = this.presentation.presented;
    if (value === previous) {
      return;
    }
    const wasConversationPresented = this.conversationPresented;
    this.headerPresentationGeneration += 1;
    this.presentation.presented = value;
    this.element.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    this.presentedChanged(value);
    this.notifyConversationPresentation(wasConversationPresented);
    this.synchronizeForegroundTranscript();
  }
  protected presentedChanged(_presented: boolean): void {}
  /** True while the authoritative transcript for this pane is still being fetched. */
  get transcriptLoading(): boolean {
    const phase = this.state ? getChatHistoryLoadState(this.state).phase : "idle";
    return phase === "pending-connection" || phase === "in-flight";
  }
  /** Scoped transient recovery is presented once in the shell connection indicator. */
  get historyRecovering(): boolean {
    return Boolean(
      this.state &&
      this.state.client === this.context?.gateway.snapshot.client &&
      isChatHistoryRetrying(this.state),
    );
  }
  /** The initial authoritative transcript has a visible result, including errors. */
  get transcriptReady(): boolean {
    if (!this.state?.connected || this.state.client !== this.context?.gateway.snapshot.client) {
      return false;
    }
    const phase = getChatHistoryLoadState(this.state).phase;
    return phase === "committed" || phase === "failed";
  }
  protected readonly synchronizeForegroundTranscript = () => {
    this.context?.connectionBootstrap.setForegroundPane(
      this,
      this.state &&
        this.isConnected &&
        this.selected &&
        this.presented &&
        this.inputRegion === "page"
        ? {
            sessionKey: resolveChatSnapshotKey(this.state, { sessionKey: this.state.sessionKey }),
            client: this.state.client,
            // Established history stays authoritative during live-event reconciliation.
            ready: this.transcriptReady || getAcceptedChatHistorySession(this.state) !== undefined,
          }
        : null,
    );
  };
  protected get headerOutcomeOwner(): string {
    return `${this.connectionGeneration}:${this.headerPresentationGeneration}`;
  }
  protected ownsHeaderOutcome(owner: string): boolean {
    return this.presented && owner === this.headerOutcomeOwner;
  }
  protected get selected(): boolean {
    return this.presentation.active;
  }
  get active(): boolean {
    // The selected split pane stays selected while another region owns input.
    return (
      this.presentation.active &&
      (!this.context || chatInputOwnerForContext(this.context).current === this.inputRegion)
    );
  }
  set active(value: boolean) {
    const previous = this.presentation.active;
    if (value === previous) {
      return;
    }
    this.presentation.active = value;
    this.activeChanged(this.active);
    this.synchronizeForegroundTranscript();
  }
  protected activeChanged(_active: boolean): void {}
  // Call wherever connectionGeneration itself advances (reconnect, capability
  // replacement, pane teardown) so a header confirm dialog open across that
  // boundary dismisses itself instead of confirming into a retired scope.
  protected retireHeaderSessionMutations(): void {
    this.headerSessionMutationAbortController.abort();
    this.headerSessionMutationAbortController = new AbortController();
  }
  protected retireHeaderSessionDrafts(): void {
    this.headerSessionDraftAbortController.abort();
    this.headerSessionDraftAbortController = new AbortController();
  }
  draft?: string = undefined;
  focusComposer = false;
  dashboardExpanded = false;
  routeFace?: BoardFace = undefined;
  onFaceChange?: (paneId: string, sessionKey: string, face: BoardFace) => void = undefined;
  onFocusPane?: (paneId: string, intent?: "review-edit") => void = undefined;
  onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void = undefined;
  onSessionDeleted?: (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft?: boolean,
  ) => void = undefined;
  narrow = false;
  mergedChrome = false;
  navDrawerOpen = false;
  gatewayStatus: GatewayStatusProps | null = null;
  onboarding = false;
  onOpenSplitView?: () => void = undefined;
  onSplitDown?: (paneId: string) => void = undefined;
  onSplitRight?: (paneId: string) => void = undefined;
  onClosePane?: (paneId: string) => void = undefined;
  boardProvider?: BoardProvider = undefined;

  private publishedRunActivity: ChatPaneStateOwner["runActivity"] = null;
  chatState: ReturnType<typeof createChatState<ChatPageHost>> = this.mountChatState();

  private mountChatState() {
    return createChatState<ChatPageHost>(
      this,
      () => {
        this.syncQueuedEditRetention();
        const activity = this.runActivity;
        if (
          activity?.client === this.publishedRunActivity?.client &&
          activity?.agentId === this.publishedRunActivity?.agentId &&
          activity?.working === this.publishedRunActivity?.working &&
          activity?.completion === this.publishedRunActivity?.completion
        ) {
          return;
        }
        this.publishedRunActivity = activity;
        this.element.dispatchEvent(new Event(CHAT_RUN_ACTIVITY_CHANGED_EVENT, { bubbles: true }));
      },
      (item) =>
        getTranscriptState(this.presentationId).transcriptRenderContext.onAsyncQuestionDiscard?.(
          item,
        ),
    );
  }

  get runActivity() {
    return this.chatState.projectRunActivity(this.state);
  }
  readonly composerCapabilities = new ChatComposerCapabilityHost();
  readonly transcript = createChatTranscript(() => this.paneId, {
    geometryEventTarget: this.element,
    getComposerFloat: () => (this.usesMobileHost ? this.composerFloat : null),
    getComposerActivityLayout: () => (this.usesMobileHost ? this.composerActivityLayout : null),
    onViewportResize: () => this.chatState.handleTranscriptResize(),
    canFollowEnd: () => this.state !== undefined && canAutoFollowChat(this.state),
    onReaderScroll: (towardEnd) => this.state && handleChatScrollTakeover(this.state, towardEnd),
  });
  protected get progressCards() {
    return sessionProgressCardsForGateway(this.context.gateway);
  }

  protected get progressCardSnapshot() {
    return readSessionProgressCard(this.progressCards, this.initialProgressCardTarget());
  }

  readonly questionPromptState = createQuestionPromptState();
  state: ChatPageHost | undefined;

  protected ownsChatSnapshot(target: Parameters<typeof resolveChatSnapshotKey>[1]): boolean {
    const state = this.state;
    const gateway = this.context.gateway;
    return Boolean(
      state &&
      resolveChatSnapshotKey(state, target) ===
        resolveChatSnapshotKey(
          {
            settings: gateway.connection,
            client: gateway.snapshot.client,
            hello: state.hello,
            assistantAgentId: state.assistantAgentId,
            agentsList: state.agentsList,
          },
          target,
        ),
    );
  }

  protected resolveChatReadTarget(): ReturnType<typeof resolveUiConversationIdentity> | undefined {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const identity = resolveUiConversationIdentity(state, state.sessionKey);
    if (identity.agentId) {
      return identity;
    }
    const session = getAcceptedChatHistorySession(state);
    // Raw retained panes follow their accepted history owner, never the selected assistant.
    if (session && parseAgentSessionKey(session.key)) {
      return resolveUiConversationIdentity(state, session.key);
    }
    return session?.agentId && (session.key === "global" || session.key === "unknown")
      ? { sessionKey: session.key, agentId: session.agentId }
      : undefined;
  }

  protected projectChildRoster(
    target: ReturnType<typeof resolveUiConversationIdentity> | undefined,
  ) {
    const sessions = target ? this.swarm.hydrator?.rows : undefined;
    return {
      swarm: target && this.swarm.enabled ? { ...target, sessions: sessions ?? [] } : undefined,
      subagentSessions: sessions,
      subagentSessionsHydrated: Boolean(target && this.swarm.hydrator?.hydrated),
      subagentSessionsPending: Boolean(target && this.swarm.hydrator?.pendingChildRead),
      subagentSessionsRead: Boolean(target && this.swarm.hydrator?.childrenRead),
      // Carry the admitted owner forward; route aliases do not identify child ancestry.
      subagentParentKey: target
        ? scopedSessionArtifactKey(target.sessionKey, target.agentId)
        : undefined,
    };
  }

  protected isCurrentSessionArchived(state: ChatPageHost): boolean {
    return (
      state.selectedChatSessionArchived ||
      state.sessionsResult?.sessions.some(
        (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
      ) === true
    );
  }
  /* Infinity until the first ResizeObserver tick so an unmeasured pane keeps
   * the wide side-by-side layout instead of flashing the stacked one. */
  paneWidth = Number.POSITIVE_INFINITY;
  protected paneResizeObserver: ResizeObserver | null = null;
  protected connectedClient: GatewayBrowserClient | null = null;
  protected boardProviderLease: (BoardProviderLease & { cacheKey: string }) | undefined;
  protected boardProviderLifecycleConnected = false;
  protected connectionGeneration = 0;
  // Owns the abort signal handed to header-scoped destructive confirm dialogs.
  // Retiring it alongside every connectionGeneration bump lets a dialog open
  // across a reconnect or pane teardown dismiss itself, matching
  // SessionDataController's own epoch-scoped controller for the sidebar.
  protected headerSessionMutationAbortController = new AbortController();
  protected headerSessionDraftAbortController = new AbortController();

  readonly headerPresentation: {
    renameValue: string;
    renameSession: Pick<GatewaySessionRow, "key" | "sessionId" | "label"> | null;
    platform: string | null;
    copiedAction: ChatPaneHeaderAction | null;
    continueInTerminalDialog: {
      qualifiedSessionKey: string;
      selectedGatewayUrl: string;
      clientGatewayUrl: string;
      scope: ChatPaneConnectionScope;
    } | null;
    placementMovingKey: string | null;
    placementReclaimingKey: string | null;
    placementRestartingKey: string | null;
    // A checkout path belongs to a worktree ID, never a reused session key.
    worktreePaths: Map<string, { loading?: boolean; path?: string | null }>;
    // Branches belong to checkout roots and refresh when their menu opens.
    branches: Map<string, { loading?: boolean; value?: string | null }>;
  } = {
    renameValue: "",
    renameSession: null,
    platform: null,
    copiedAction: null,
    continueInTerminalDialog: null,
    placementMovingKey: null,
    placementReclaimingKey: null,
    placementRestartingKey: null,
    worktreePaths: new Map(),
    branches: new Map(),
  };
  readonly presence = createChatPanePresence(() => {
    const snapshot = this.context?.gateway.snapshot;
    return {
      sessionKey: this.state?.sessionKey ?? this.sessionKey,
      selfUser: snapshot?.selfUser,
      selfInstanceId: snapshot?.client?.instanceId,
    };
  });
  readonly collaboration: {
    sharingStates: Map<string, ChatSessionSharingState>;
    suggestions: SessionSuggestion[];
    role: SessionSharingRole | undefined;
    busyIds: Set<string>;
    addOperation: symbol | undefined;
    editOperation: symbol | undefined;
    typingViews: ChatTypingActorView[];
    typingOverflow: ChatTypingOverflow | undefined;
    reactions: Map<string, MessageReactionSummary[]>;
  } = {
    sharingStates: new Map(),
    suggestions: [],
    role: undefined,
    busyIds: new Set(),
    addOperation: undefined,
    editOperation: undefined,
    typingViews: [],
    typingOverflow: undefined,
    reactions: new Map(),
  };
  protected readonly sessionSharingHydrationTargets = new Map<string, string>();
  protected readonly sessionParticipationTracker = new SessionParticipationTracker();
  readonly resetConfirmation: {
    pending:
      | {
          scopeKey: string;
          promise: Promise<boolean>;
          resolve: (confirmed: boolean) => void;
        }
      | undefined;
  } = { pending: undefined };
  protected readonly observedBoardPresence = new Map<string, boolean>();
  protected dashboardPresentationActivation?: {
    client: ChatPageHost["client"];
    key: string;
    expanded: boolean;
    pendingRoute?: boolean;
  };
  readonly swarm: { hydrator: SwarmRosterHydrator | null; enabled: boolean } = {
    hydrator: null,
    enabled: true,
  };
  readonly sessionDiscussion = createChatPaneDiscussionState();
  readonly pendingPanelToggles = {
    requests: new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>(),
  };
  protected readonly sessionDiscussionProbes = new Set<string>();
  protected readonly sessionDiscussionPanels = new Map<
    string,
    {
      generation: number;
      canOpen: boolean;
      config: SessionDiscussionPanelConfig;
    }
  >();
  protected presentationUserId: string | null = null;
  protected readonly retrySessionPlacementStartup = () => {
    const sessionKey = this.state?.sessionKey;
    if (sessionKey) {
      this.context.placementStartup.retry(sessionKey);
    }
  };
  protected headerRenameInitialValue = "";
  protected headerCopiedTimer: number | null = null;
  protected composerPrefillAttentionTimer: number | null = null;
  protected composerPrefillAttentionTarget: HTMLElement | null = null;

  protected nativeDraftCleanup: (() => void) | null = null;
  protected readonly unreadPatchGuard = new SessionUnreadPatchGuard();
  protected sessionSuggestionsRequestVersion = 0;
  protected sessionSuggestionsRefreshPromise: Promise<void> | undefined;
  protected sessionSuggestionsRefreshVersion: number | undefined;
  protected sessionSuggestionsRefreshQueued = false;
  protected sessionSuggestionTargetSignature = "";
  protected readonly typingActors = new Map<string, ChatTypingActorState>();
  protected readonly typingTimers = new Map<string, number>();
  readonly publication: { binding: GitHubPublicationBinding | null } = { binding: null };
  readonly workspaceConflicts = { dismissedRefs: new Map<string, string>() };
  readonly history = projectChatFields<{
    catalogMessages: unknown[];
    catalogLoading: boolean;
    loadingOlder: boolean;
    catalogCursor: string | undefined;
    catalogSession: SessionCatalogSession | null;
    catalogHost: SessionCatalogHost | null;
  }>({
    catalogMessages: [],
    catalogLoading: false,
    loadingOlder: false,
    catalogCursor: undefined,
    catalogSession: null,
    catalogHost: null,
  });
  protected catalogLoadGeneration = 0;
  protected catalogRequestedSessionKey: string | null = null;
  protected olderLoadGeneration = 0;
  protected historyObserver: IntersectionObserver | null = null;
  protected historyObserverSentinel: HTMLElement | null = null;
  protected historyObserverArmed = false;
  protected historyAutoLoadBlocked = false;
  protected historyIntentTimer: number | null = null;
  protected transcriptScrollTop: number | null = null;
  // Older cursors already requested this session. A provider that cycles cursors
  // (c1 -> c2 -> c1) on empty/duplicate pages would otherwise loop forever, since
  // the sentinel never scrolls out of view when nothing new renders.
  protected readonly olderCursorsSeen = new Set<string>();

  constructor(
    readonly element: HTMLElement,
    public context: ApplicationContext,
  ) {}

  readonly boardPresentation: { provider: BoardProvider | undefined } = {
    provider: undefined,
  };
  private stopBoardSubscriptions: (() => void) | undefined;

  refreshBoardSubscriptions(): void {
    if (!this.isConnected) {
      return;
    }
    const provider = this.resolveBoardProvider();
    if (provider === this.boardPresentation.provider) {
      return;
    }
    this.stopBoardSubscriptions?.();
    this.boardPresentation.provider = provider;
    // Commands must reach the synchronous pane owner in order, including while parked.
    this.stopBoardSubscriptions = provider.events.subscribe((event) =>
      this.handleBoardCommand(event),
    );
  }

  protected abstract refreshSessionPullRequests(options?: {
    refresh?: boolean;
    automatic?: boolean;
  }): boolean;
  protected abstract commitSidebarLayout(
    layout: SidebarLayout,
    options?: Parameters<ChatPageHost["updateSidebarLayout"]>[1],
  ): void;
  protected abstract refreshSwarmRoster(): void;
  protected abstract resolveBoardProvider(): BoardProvider;
  protected abstract handleBoardCommand(event: BoardCommandEvent): void;
  protected abstract reconcileWaitingApprovalSnapshot(
    approvalQueue?: ApplicationContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean;
  protected abstract publishHeaderError(error: unknown, owner?: string): void;
  protected abstract probeSessionDiscussion(sessionKey: string): Promise<void>;
  protected abstract initialProgressCardTarget():
    | ReturnType<typeof resolveUiConversationIdentity>
    | undefined;
  protected abstract secondarySessionReadsReady(explicit?: boolean): boolean;
  protected abstract loadHeaderPlatform(
    client: GatewayBrowserClient,
    generation: number,
  ): Promise<void>;
  protected abstract applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
  ): void;
  protected abstract applyApplicationConfig(config: ApplicationContext["config"]["current"]): void;
  protected abstract applySessionsState(state: ApplicationContext["sessions"]["state"]): void;
  protected abstract cancelHeaderRename(): void;
  protected abstract handleArchiveSessionShortcut(event: KeyboardEvent): boolean;
  protected abstract resetOlderMessagesViewport(): void;
  protected abstract syncQueuedEditRetention(): void;
}
