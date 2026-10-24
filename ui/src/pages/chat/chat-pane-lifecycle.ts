import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionSuggestionEvent,
  SessionTypingEvent,
  TaskSuggestionEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import { availableLinkReaders } from "../../app/link-reader-routing.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import {
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
} from "../../app/question-prompt.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { BROWSER_ANNOTATION_EVENT } from "../../components/browser/browser-annotation-event.ts";
import { hasModalSurface } from "../../components/overlay-registry.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { isSessionReactionEvent } from "../../lib/protocol-validators.generated/activity.js";
import { listen } from "../../lib/reactive/listener.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { takeCreatedComposer } from "../new-session/creation-composer-registry.ts";
import * as chatAvatars from "./chat-avatar.ts";
import { CHAT_ROUTE_READY_EVENT } from "./chat-history-events.ts";
import { retireInitialChatSnapshot } from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import {
  type ChatAttachmentGatewayOwner,
  ChatPaneComposerHandoff,
  discardStateStagedAttachments,
  preparePaneStagedAttachments,
  replacePaneStagedAttachmentGatewayOwner,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import {
  focusBrowserAnnotationComposerAfterUpdate,
  receiveBrowserAnnotation as admitBrowserAnnotation,
} from "./chat-pane-browser-annotation.ts";
import { createChatPaneMcpApps } from "./chat-pane-mcp-app.ts";
import { resolveSidebarPanelShortcut } from "./chat-pane-panel-shortcuts.ts";
import { openPreferredSidebarPanel, releaseAttachmentWorkspaceOwner } from "./chat-pane-rails.ts";
import { ChatPaneSessionObservation } from "./chat-pane-session-observation.ts";
import { createChatPaneSessionPanelToggles } from "./chat-pane-session-panel-toggle.ts";
import { focusChatComposerFromPrintableKeydown } from "./chat-pane-shared.ts";
import { resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import { subscribeChatPaneSnapshotInvalidation } from "./chat-pane-startup-subscriptions.ts";
import type { ChatPaneInputChanges } from "./chat-pane-state-owner.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { cancelChatModelRecovery } from "./chat-session.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  applyChatAgentOwnerTransition,
  applySelectedChatAgent,
  refreshPageChat,
  refreshChatModelAuthStatus,
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { resolveChatAttachmentLimits } from "./components/chat-attachment-admission.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message-confirmation-view.tsx";
import { openSessionWorkspaceFile } from "./components/chat-session-workspace.ts";
import { resetThreadPresentation } from "./components/chat-thread-interactions.ts";
import { retainCreatedIncognitoComposerScope } from "./composer-persistence-state.ts";
import { connectCreatedComposerQueue } from "./creation-composer-recovery.ts";
import { exportChatMarkdown } from "./export.ts";
import { admitChatSubmission } from "./history-merge.ts";
import {
  admitInitialChatTurn,
  admitInitialTurnHandoff,
  readAcknowledgedInitialRun,
} from "./initial-turn-handoff-admission.ts";
import { subscribeInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { applyChatCacheSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";
import { closeSlot } from "./sidebar-layout.ts";

export abstract class ChatPaneLifecycle extends ChatPaneSessionObservation {
  private panelActions: { syncLaunch: () => void; flush: () => void } | undefined;

  protected flushPendingPanelToggles(): void {
    this.panelActions?.flush();
  }

  /** Called by the mounted Solid view, after the runtime has attached its state. */
  mountPanelActions(): void {
    const flush = createChatPaneSessionPanelToggles({
      current: () => {
        const state = this.state;
        return state && this.active && this.presented
          ? {
              sidebarRegion: this.sidebarRegionView,
              state,
              linkReaders: availableLinkReaders(this.context.gateway.snapshot),
              pluginPanels: this.context.plugins.registrations("panels").map((entry) => entry.key),
              awaitDomCommit: () => this.awaitDomCommit(),
            }
          : null;
      },
      pending: this.pendingPanelToggles,
      updateSidebarLayout: (layout) => this.commitSidebarLayout(layout),
      onOpenPanel: (slot) => this.navigateMobileHost({ area: "panels", slot }),
    });

    const syncLaunch = createChatPaneMcpApps({
      element: this.element,
      current: () => {
        const state = this.state;
        return state
          ? {
              context: this.context,
              state,
              presented: this.presented,
              agentId: this.agentId,
              launch: this.mcpAppLaunch,
              replaceAttachments: this.chatState.attachmentInputProps(state).onAttachmentsChange,
              openFile: (path) => openSessionWorkspaceFile(state, { path }),
            }
          : null;
      },
    });
    this.panelActions = { syncLaunch, flush };
  }

  private chatRouteReadyReported = false;
  protected stagedAttachmentGatewayOwner: ChatAttachmentGatewayOwner = null;
  private suppressStagedAttachmentHandoffOnDisconnect = false;
  private composerPresentation: ChatPaneComposerHandoff | undefined;

  protected activateComposerPresentation(): void {
    if (this.selected && this.presented) {
      this.composerPresentation?.claim();
    }
  }

  public discardStagedAttachments(): void {
    // Explicit pane disposal is terminal. The DOM disconnect that follows must
    // not recreate an empty fallback handoff under a later reused pane id.
    this.suppressStagedAttachmentHandoffOnDisconnect = true;
    this.chatState.attachmentReads.abortReads();
    discardStateStagedAttachments(this.state);
  }

  public resumeStagedAttachments(): void {
    this.suppressStagedAttachmentHandoffOnDisconnect = false;
  }

  protected replaceStagedAttachmentGatewayOwner(nextOwner: ChatAttachmentGatewayOwner): void {
    this.stagedAttachmentGatewayOwner = replacePaneStagedAttachmentGatewayOwner(
      this.context,
      this.paneId,
      this.state,
      this.stagedAttachmentGatewayOwner,
      nextOwner,
    );
  }

  protected syncActiveBindings() {
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (!this.state || !this.active || !this.presented) {
      // Returning to this pane must not revive a command's deferred focus intent.
      this.sessionCompanionFocusGeneration += 1;
      this.announceCommandPaletteTarget(null);
      return;
    }
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    // Native draft commands must pass through the synchronous editing owner in order.
    this.nativeDraftCleanup = this.context.nativeChatDrafts.subscribe((draft) => {
      const state = this.state;
      if (!state || !this.active || !this.presented) {
        return;
      }
      state.handleChatDraftChange(draft, []);
    });
  }

  private readonly handlePaneInput = () => {
    this.sessionCompanionFocusGeneration += 1;
  };

  protected readonly handlePaneFocus = () => {
    this.sessionCompanionFocusGeneration += 1;
    chatInputOwnerForContext(this.context).claim(this.inputRegion);
    this.onFocusPane?.(this.paneId);
  };

  /** Receives one complete browser annotation without mixing generated context into the user's draft. */
  protected receiveBrowserAnnotation(event: Event): void {
    const state = this.state;
    if (
      !state ||
      !admitBrowserAnnotation(
        state,
        this.active && this.presented,
        event,
        this.chatState.attachmentReads.pendingBytes(
          resolveChatAttachmentLimits(state.hello?.policy),
        ),
        this.chatState.attachmentInputProps(state).onAttachmentsChange,
      )
    ) {
      return;
    }
    // A null mount binds only when its first annotation ownership begins.
    this.stagedAttachmentGatewayOwner ??= this.context.gateway.snapshot.client;
    focusBrowserAnnotationComposerAfterUpdate({
      composer: () => getChatComposerState(this.presentationId).composerTextarea,
      updateComplete: this.awaitDomCommit(),
    });
  }

  protected readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    const state = this.state;
    // Retained panes keep their document listeners; only the current input owner
    // may consume a key before the visible pane receives it.
    if (
      !state ||
      !this.active ||
      !this.presented ||
      event.defaultPrevented ||
      hasModalSurface(this.element.ownerDocument) ||
      this.handleArchiveSessionShortcut(event)
    ) {
      return;
    }
    const discussionState = this.sessionDiscussion.snapshot.states.get(state.sessionKey.trim());
    const slot = resolveSidebarPanelShortcut(event, () => ({
      state,
      desktopAvailable: isDesktopPanelAvailable(this.context.gateway.snapshot),
      discussion: state.connected && state.client ? true : null,
      discussionAvailable: discussionState === "available" || discussionState === "open",
      dashboardAvailable: () => !this.compact && this.isBoardPanelAvailable(),
    }));
    if (slot) {
      event.preventDefault();
      const visible = this.isSlotShown(state.sidebarLayout, slot);
      if (visible) {
        releaseAttachmentWorkspaceOwner(state, slot);
      }
      this.commitSidebarLayout(
        visible
          ? closeSlot(state.sidebarLayout, slot)
          : openPreferredSidebarPanel(state, state.sidebarLayout, slot),
      );
      if (!visible) {
        this.navigateMobileHost({ area: "panels", slot });
      }
      return;
    }

    focusChatComposerFromPrintableKeydown(
      this.element,
      event,
      getChatComposerState(this.presentationId).composerTextarea,
    );
  };

  override start() {
    this.boardProviderLifecycleConnected = true;
    this.resumeStagedAttachments();
    super.start();
    const mountGatewayOwner = this.context.gateway.snapshot.client;
    this.stagedAttachmentGatewayOwner = mountGatewayOwner;
    if (typeof ResizeObserver === "function") {
      this.paneResizeObserver = new ResizeObserver((entries) => {
        const width = entries.at(-1)?.contentRect.width;
        // Hidden panes (narrow split view) report 0; keep the last real width.
        if (typeof width === "number" && width > 0 && width !== this.paneWidth) {
          this.transcript.syncViewportGeometry();
          this.paneWidth = width;
        }
      });
      this.paneResizeObserver.observe(this.element);
    }
    const chatState = this.chatState;
    chatState.addCleanup(() => publishChatWorkContext(this.context, this));
    chatState.addCleanup(listen(this.element, "pointerdown", this.handlePaneFocus));
    chatState.addCleanup(listen(this.element, "focusin", this.handlePaneFocus));
    chatState.addCleanup(listen(this.element, "input", this.handlePaneInput));
    chatState.addCleanup(
      listen(document, "keydown", { handleEvent: this.handleDocumentKeydown }, true),
    );
    const pageState = createPageState(
      this.context,
      chatState.createRenderLifecycle(),
      {
        sessionKey: this.sessionKey,
        dispatchEvent: (event) => this.element.dispatchEvent(event),
        transcriptLoadingChanged: this.synchronizeForegroundTranscript,
      },
      this.chatMessagesBySession,
    );
    pageState.chatMetadataIsPresented = () =>
      this.presented && document.visibilityState !== "hidden";
    const refreshPresentedReads = () => {
      if (pageState.chatMetadataIsPresented?.()) {
        void refreshChatMetadata(pageState);
        this.resumeDeferredSessionHydration();
        this.markSessionRead(selectedChatSessionRow(pageState));
        void this.refreshTaskSuggestions({ automatic: true });
      }
    };
    chatState.addCleanup(listen(document, "visibilitychange", refreshPresentedReads));
    const paneAgentId = parseAgentSessionKey(this.sessionKey)?.agentId ?? this.agentId;
    if (paneAgentId) {
      pageState.assistantAgentId = paneAgentId;
      pageState.agentsSelectedId = paneAgentId;
    }
    pageState.sidebarLayout = this.restorePaneSidebarLayout(pageState.sidebarLayout);
    pageState.getWorkContext = () => this.workContext;
    pageState.isRouteSessionPending = () => this.routeResolutionPending;
    // Task tabs can precede main chat in DOM order; viewport reads and commands
    // must resolve through the same transcript owner.
    pageState.chatIsProgrammaticScroll = () => this.transcript.isProgrammaticScroll;
    pageState.chatIsMaintenanceScroll = () => this.transcript.isMaintenanceScroll;
    pageState.chatScrollElement = () => this.transcript.scrollElement;
    pageState.chatScrollToEnd = (options) => this.transcript.scrollToEnd(options);
    pageState.chatCancelScroll = () => this.transcript.cancelScroll();
    pageState.reviewQueuedMessageEdit = () => this.reviewQueuedMessageEdit(pageState);
    pageState.createChatSession = () => this.createSession();
    pageState.confirmConversationReset = () => this.confirmConversationReset();
    pageState.exportCurrentChat = () =>
      exportChatMarkdown(pageState.chatMessages, pageState.assistantName);
    pageState.refreshCurrentChat = async () => {
      await refreshPageChat(pageState);
    };
    pageState.refreshSessionPullRequests = (options) => this.refreshSessionPullRequests(options);
    pageState.openSessionCompanion = (question) => this.openSessionCompanion(pageState, question);
    pageState.retireSessionCompanion = (key, agentId) =>
      this.sessionCompanionThreads.retire(key, agentId);
    this.state = pageState;
    if (this.sessionKey) {
      const initialSessionKey = this.setPaneSessionKey(this.sessionKey);
      if (initialSessionKey && !parseCatalogSessionKey(initialSessionKey)) {
        // First-turn handoffs are scoped to their Gateway client and must be
        // claimed before attach starts outbox and transcript hydration.
        pageState.client = this.context.gateway.snapshot.client ?? null;
        const initialRun = readAcknowledgedInitialRun(pageState);
        const snapshot = readChatSessionSnapshot(pageState.chatMessagesBySession, pageState, {
          sessionKey: initialSessionKey,
        });
        if (snapshot && this.ownsChatSnapshot({ sessionKey: initialSessionKey })) {
          applyChatCacheSnapshot(pageState, snapshot);
          const target = this.resolveChatReadTarget();
          if (target && snapshot.progressCard !== undefined) {
            this.progressCards.hydrate(target, snapshot.progressCard);
          }
        } else {
          this.hydrateStoredChatSnapshot(pageState, initialSessionKey);
        }
        admitInitialChatTurn(pageState, initialRun);
      }
    }
    chatState.attach(pageState);
    chatState.addCleanup(() => this.retireSessionObservation());
    chatState.addCleanup(
      subscribeInitialTurnHandoff(() => {
        admitInitialTurnHandoff(pageState, pageState.sessionKey);
      }),
    );
    // Identity publications start scoped loads even when this retained pane is hidden.
    chatState.addCleanup(
      this.context.agentIdentity.subscribe(() => void pageState.loadAssistantIdentity()),
    );
    const creationComposer = takeCreatedComposer(
      this.context,
      pageState.sessionKey,
      mountGatewayOwner,
    );
    if (creationComposer?.incognito) {
      pageState.selectedChatSessionIncognito = true;
      retainCreatedIncognitoComposerScope(pageState, creationComposer.isCurrent);
    }
    chatState.composerPersistence.restore({ preserveCurrent: true });
    const sessionHandoff = this.takeSessionHandoff(pageState.sessionKey);
    restorePaneStagedAttachments(this.context, this.paneId, pageState, mountGatewayOwner);
    if (creationComposer?.claimDraft()) {
      pageState.chatMessage = creationComposer.draft;
      pageState.chatMentions = creationComposer.mentions;
      pageState.chatAttachments = creationComposer.attachments;
      chatState.adoptAttachmentReads(creationComposer.reads, pageState);
    }
    chatState.composerPersistence.start();
    if (sessionHandoff) {
      this.applySessionHandoff(pageState.sessionKey, sessionHandoff);
    }
    if (this.draft !== undefined) {
      this.state.handleChatDraftChange(this.draft, []);
    }
    const handleBrowserAnnotation = (event: Event) => this.receiveBrowserAnnotation(event);
    chatState.addCleanup(listen(window, BROWSER_ANNOTATION_EVENT, handleBrowserAnnotation));
    // Each connection edge retires media custody and transcript subscriptions synchronously.
    chatState.addCleanup(
      this.context.gateway.subscribe((next) => {
        this.applyGatewaySnapshot(next);
        this.activateComposerPresentation();
        this.synchronizeForegroundTranscript();
      }),
    );
    // Chat actions read these synchronous owner settings before any render commits.
    chatState.addCleanup(
      this.context.theme.subscribe(() => {
        pageState.settings = {
          ...this.context.theme.settings,
          token: this.context.gateway.connection.token,
        };
      }),
    );
    // Agent changes retire scoped owners and subscriptions before admitting another action.
    chatState.addCleanup(
      this.context.agentSelection.subscribe((next) => {
        const previousAgentId = this.state?.assistantAgentId;
        applySelectedChatAgent(this.state, this.agentId ?? next.selectedId);
        this.synchronizeSessionObservation();
        const agentChanged = this.state?.assistantAgentId !== previousAgentId;
        if (agentChanged) {
          this.refreshBoardSubscriptions();
          this.swarm.hydrator?.dispose();
          this.swarm.hydrator = null;
        }
        this.synchronizeForegroundTranscript();
        if (agentChanged) {
          this.refreshSwarmRoster();
        }
        if (this.state) {
          void syncSelectedSessionMessageSubscription(this.state);
        }
        this.activateComposerPresentation();
      }),
    );
    this.subscribeSessionRepositoryContext();
    chatState.addCleanup(
      this.context.gateway.subscribeEvents((event) => {
        const state = this.state;
        if (state && modelAuthEventInvalidates(event)) {
          state.modelAuthStatusResult = null;
          void refreshChatModelAuthStatus(state);
        }
        if (state && event.event === "sessions.changed") {
          const reason = asNonArrayRecord(event.payload).reason;
          if (reason === "sharing") {
            // Revoked readers receive only a redacted catalog invalidation. Retire
            // preview admission before the roster refresh can publish access loss.
            state.mediaPolicyEpoch = (state.mediaPolicyEpoch ?? 0) + 1;
          }
          if (reason === "sharing" || reason === "profile-identity") {
            this.invalidateSessionSharing(event.payload);
          }
        }
        if (event.event === "sessions.changed" || event.event === "session.message") {
          return;
        }
        if (event.event === "presence") {
          const hadMultipleIdentities = this.hasMultipleIdentities();
          const presence = readPresenceEntries(event.payload);
          this.presence.update(presence ? { presence } : undefined);
          this.pruneTypingActors();
          if (!this.hasMultipleIdentities()) {
            this.resetSessionSuggestions();
            this.clearTypingActors();
          } else if (!hadMultipleIdentities) {
            void this.refreshSessionSuggestions();
          }
        }
        if (state) {
          if (event.event === "config.changed") {
            this.invalidateSessionSharing(undefined);
            state.mediaPolicyEpoch = (state.mediaPolicyEpoch ?? 0) + 1;
          }
          if (event.event === "config.changed" || event.event === "agent.identity.changed") {
            chatAvatars.invalidateChatAvatarCache(state);
            void chatAvatars.refreshChatAvatar(state);
            void chatAvatars.refreshSenderAgentAvatars(state);
          }
          handleQuestionPromptEvent(this.questionPromptState, event);
        }
        if (state && !parseCatalogSessionKey(state.sessionKey)) {
          if (event.event === "task.suggestion" && event.payload) {
            this.handleTaskSuggestionEvent(event.payload as TaskSuggestionEvent);
          }
          if (event.event === "session.suggestion" && event.payload) {
            this.handleSessionSuggestionEvent(event.payload as SessionSuggestionEvent);
          }
          if (event.event === "session.reaction" && isSessionReactionEvent(event.payload)) {
            this.handleSessionReactionEvent(event.payload);
          }
          if (event.event === "session.typing" && event.payload) {
            this.handleSessionTypingEvent(event.payload as SessionTypingEvent);
          }
          handlePageGatewayEvent(state, event, () => this.presented);
          if (event.event === "node.runnerInventory.changed") {
            this.activeSessionResources.reconcileObservation();
          }
        }
      }),
    );
    this.applyApplicationConfig(this.context.config.current);
    // Apply execution/media policy at publication, not at Solid's deferred render boundary.
    chatState.addCleanup(this.context.config.subscribe(this.applyApplicationConfig.bind(this)));
    this.applySessionsState(this.context.sessions.state);
    // Roster receipts also evict deleted history, settle pending aborts, and admit queued sends.
    chatState.addCleanup(this.context.sessions.subscribe(this.applySessionsState.bind(this)));
    chatState.addCleanup(
      this.context.placementStartup.subscribe(() => {
        const state = this.state;
        if (state) {
          // Admit each accepted initial turn before waking followers parked behind recovery.
          admitChatSubmission(state, getChatPendingInputs(state)?.page.items);
          if (!parseCatalogSessionKey(state.sessionKey)) {
            void resumeStoredChatOutboxes(state);
          }
        }
      }),
    );
    chatState.addCleanup(
      subscribeChatPaneSnapshotInvalidation(
        () => this.state,
        () => {
          const target = this.resolveChatReadTarget();
          if (target) {
            this.progressCards.invalidate(target);
          }
        },
      ),
    );
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
    this.synchronizeForegroundTranscript();
    const composerPresentation = new ChatPaneComposerHandoff(this.context, {
      state: () => this.state,
      owner: () => this.stagedAttachmentGatewayOwner,
      presentationOwner: () => this.chatState.composerPersistence.presentationOwner,
      region: () => this.inputRegion,
      presented: () => this.selected && this.presented,
      pause: () => this.chatState.composerPersistence.stop(),
      takeAttachmentReads: () => this.chatState.takeAttachmentReads(),
      adoptAttachmentReads: (reads) => this.chatState.adoptAttachmentReads(reads, pageState),
      resume: (restore) => {
        if (restore) {
          this.chatState.composerPersistence.restore();
        }
        this.chatState.composerPersistence.start();
      },
    });
    this.composerPresentation = composerPresentation;
    pageState.captureComposerRecoveryOwner = () => composerPresentation.captureOwner();
    this.activateComposerPresentation();
    if (creationComposer) {
      chatState.addCleanup(connectCreatedComposerQueue(this.context, pageState, creationComposer));
    }
  }

  override synchronizeInputs(changes: ChatPaneInputChanges) {
    this.captureArchivePresentationFocus();
    if (changes.sessionKey && this.state) {
      const catalogKey = parseCatalogSessionKey(this.sessionKey);
      const nextSessionKey = catalogKey
        ? this.sessionKey
        : resolveSessionKey(this.sessionKey, this.context.gateway.snapshot.hello);
      if (nextSessionKey) {
        // Availability belongs to one activation. The replacement probe starts
        // after its transcript commit in deferSessionHydrationUntilTranscript.
        this.sessionDiscussion.forgetState(nextSessionKey);
      }
      if (catalogKey && this.catalogRequestedSessionKey !== this.sessionKey) {
        this.catalogLoadGeneration += 1;
        this.openCatalogSession(catalogKey, this.state);
      } else if (nextSessionKey) {
        // A retained pane owns one conversation for its lifetime. Only its
        // canonical spelling can change after Gateway defaults resolve.
        this.state.sessionKey = nextSessionKey;
        const initialRun = readAcknowledgedInitialRun(this.state);
        const nextAgentId = parseAgentSessionKey(nextSessionKey)?.agentId;
        if (nextAgentId) {
          applyChatAgentOwnerTransition(this.state, nextAgentId);
        }
        this.synchronizeSessionObservation();
        // A pane routed straight onto the created session never runs the switch
        // path, so its one-shot handoffs would expire unclaimed: the rejected turn
        // would vanish instead of offering a retry, and the accepted prompt would
        // stay hidden until the transcript bootstrap resolved.
        admitInitialChatTurn(this.state, initialRun);
      }
      if (nextSessionKey) {
        const handoff = this.takeSessionHandoff(nextSessionKey);
        if (handoff) {
          this.applySessionHandoff(nextSessionKey, handoff);
        }
      }
    }
    if (changes.sessionKey || changes.inputRegion) {
      this.syncActiveBindings();
      this.activateComposerPresentation();
    }
    if (
      changes.draft &&
      this.draft !== undefined &&
      this.state &&
      this.draft !== this.state.chatMessage
    ) {
      this.state.handleChatDraftChange(this.draft, []);
    }
    this.syncSessionReactions();
    this.syncRetainedBoardSession(this.resolveBoardView());
    this.resumeConfirmedRouteWork(changes.routeResolutionPending);
  }

  override afterRender(focusComposerChanged: boolean) {
    this.panelActions?.syncLaunch();
    void chatAvatars.refreshSenderAgentAvatars(this.state);
    const textarea = getChatComposerState(this.presentationId).composerTextarea;
    if (!this.chatRouteReadyReported && textarea) {
      // The outer router commit is not a meaningful chat paint. Keep the
      // handoff cover until this pane has committed its usable composer.
      this.chatRouteReadyReported = true;
      this.element.dispatchEvent(
        new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true, composed: true }),
      );
    }
    if (focusComposerChanged && this.focusComposer) {
      const input = textarea?.closest<HTMLElement>(".agent-chat__input");
      textarea?.focus({ preventScroll: true });
      if (input && this.draft) {
        this.showComposerPrefillAttention(input);
      }
    }
    this.retireArchivedPresentation();
    this.cancelResetConfirmationForSessionChange();
    this.syncHistoryObserver();
    this.panelActions?.flush();
    this.activeSessionResources.syncPane({
      state: () => this.state,
      observation: () => this.resourceSessionObservation(),
      gateway: this.context.gateway.snapshot,
      isConnected: () => this.isConnected,
      isPresented: () => this.presented && this.visuallyPresented,
      commit: (layout, automaticResource) =>
        this.commitSidebarLayout(layout, { persist: false, automaticResource }),
    });
    if (this.state) {
      const layout = this.initializeBrowserSidebarLayout(this.state.sidebarLayout);
      if (layout !== this.state.sidebarLayout) {
        this.state.updateSidebarLayout(layout, { geometryOnly: true });
      }
    }
    this.setConversationVisible(
      Boolean(
        this.state &&
        this.isSlotShown(
          resolveSidebarLayoutForBoard({
            board: this.resolveBoardView(),
            layout: this.state.sidebarLayout,
            paneWidth: this.paneWidth,
          }),
          "conversation",
        ),
      ),
    );
  }

  override dispose() {
    this.panelActions = undefined;
    this.activeSessionResources.sync(null);
    this.syncSessionCompanionPresentation(false);
    this.composerPresentation?.dispose();
    this.composerPresentation = undefined;
    if (this.state) {
      cancelChatModelRecovery(this.state);
      retireInitialChatSnapshot(this.state);
      chatAvatars.invalidateChatAvatarCache(this.state);
      retireChatMetadataRequests(this.state);
      if (this.suppressStagedAttachmentHandoffOnDisconnect) {
        // MCP app teardown can delay DOM removal after pane close. Finalize any
        // attachment that completed during that delay instead of leaking it.
        discardStateStagedAttachments(this.state);
      } else {
        preparePaneStagedAttachments(
          this.context,
          this.paneId,
          this.state,
          this.stagedAttachmentGatewayOwner,
          this.chatState.composerPersistence.draftRevision,
          this.chatState.composerPersistence.presentationOwner,
        );
      }
    }
    this.stagedAttachmentGatewayOwner = null;
    this.clearComposerPrefillAttention();
    this.boardProviderLifecycleConnected = false;
    this.releaseBoardProviderLease();
    this.settleResetConfirmation(false);
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
    this.retireReplyMessages();
    this.retireHeaderSessionMutations();
    this.retireHeaderSessionDrafts();
    this.retireDeferredSessionHydration();
    this.sessionDiscussionPanels.clear();
    this.taskSuggestionsRequestVersion += 1;
    this.setTaskSuggestions([]);
    this.tasks.operations = new Map();
    this.resetSessionSuggestions();
    this.resetSessionReactions();
    this.clearTypingActors();
    this.resetSessionPullRequests();
    this.resetOlderMessagesViewport();
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (this.headerCopiedTimer !== null) {
      window.clearTimeout(this.headerCopiedTimer);
      this.headerCopiedTimer = null;
    }
    this.swarm.hydrator?.dispose();
    this.swarm.hydrator = null;
    this.headerPresentation.worktreePaths = new Map();
    this.headerPresentation.branches = new Map();
    this.presence.update(undefined);
    this.announceCommandPaletteTarget(null);
    dismissConfirmedActionPopovers(this.element);
    resetChatComposerState(this.presentationId);
    resetThreadPresentation(this.presentationId);
    this.state = undefined;
    this.connectedClient = null;
    disposeQuestionPromptState(this.questionPromptState);
    super.dispose();
  }
}
