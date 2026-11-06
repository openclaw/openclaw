import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import {
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { rewindChatHistory, switchChatHistoryBranch } from "./chat-history-actions.ts";
import { hasVisibleOlderHistoryPage } from "./chat-history-page-visibility.ts";
import { chatHistoryPageSelector } from "./chat-history-request.ts";
import {
  chatHistoryRequests,
  getChatHistoryLoadState,
  retireChatHistoryRead,
} from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import {
  loadChatHistory,
  restoreChatHistoryBookmark,
  resumePendingChatHistoryLoad,
} from "./chat-history.ts";
import { ChatPaneHistoryPackets } from "./chat-pane-history-packets.ts";
import {
  CHAT_HISTORY_PREFETCH_EDGE_PX,
  CHAT_HISTORY_INTENT_IDLE_MS,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { saveChatTranscriptReadingPosition } from "./chat-pane-transcript-residency.ts";
import { TranscriptHistoryInput } from "./chat-scroll-input.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type { TranscriptNativeScroll } from "./components/chat-transcript-scroll-events.ts";
import { persistChatComposerState } from "./composer-draft-storage.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";
import type { ChatReadingBookmark } from "./scroll.ts";
import { resetToolStream } from "./tool-stream-state.ts";

export abstract class ChatPaneHistory extends ChatPaneHistoryPackets {
  protected bindTranscriptViewport(pageState: NonNullable<ChatPaneHistory["state"]>): void {
    // Task tabs can precede main chat in DOM order; viewport reads and commands
    // must resolve through the same transcript owner.
    pageState.chatIsProgrammaticScroll = () => this.transcript.isProgrammaticScroll;
    pageState.chatIsMaintenanceScroll = () => this.transcript.isMaintenanceScroll;
    pageState.chatScrollElement = () => this.transcript.scrollElement;
    pageState.chatScrollToEnd = (options) => this.transcript.scrollToEnd(options);
    pageState.chatCancelScroll = () => this.transcript.cancelScroll();
    pageState.transcriptMessagesRetired = (messages) =>
      this.retireTranscriptMessageSources(messages);
    pageState.readTranscriptReaderSnapshot = () => this.readTranscriptReaderSnapshot();
    pageState.beforeHistoryTailRestore = () => this.retireTranscriptReads();
  }

  private activeOlderLoad: Promise<boolean> | null = null;
  private activeOlderRead: AbortController | null = null;
  private activeNewerRead: AbortController | null = null;
  private historyViewportFillAttempted = false;
  private readonly historyInput = new TranscriptHistoryInput();
  private retireOlderMessagesReads(interrupted = false, keep?: "newer"): void {
    this.olderLoadGeneration += 1;
    this.activeOlderLoad = null;
    this.activeOlderRead?.abort();
    this.activeOlderRead = null;
    if (this.stagedHistory.direction !== keep || !keep) {
      this.stagedHistory.controller.abort();
      this.stagedHistory = { controller: new AbortController(), page: null, load: null };
    }
    if (this.history.loadingOlder) {
      if (interrupted) {
        this.history.olderError = t("chat.thread.earlierInterrupted");
      }
      // A cancelled viewport fill remains eligible after reveal. Do not reset
      // scroll anchors, consumed cursors, or the reader's navigation intent.
      this.historyViewportFillAttempted = false;
      this.history.loadingOlder = false;
    }
    this.clearHistoryObserver();
  }

  protected restoreTranscriptBookmark(
    bookmark: ChatReadingBookmark,
    isCurrent: () => boolean,
  ): Promise<boolean | undefined> {
    const state = this.state;
    return state
      ? restoreChatHistoryBookmark(
          state,
          bookmark,
          () => this.state === state && isCurrent(),
          this.transcriptReadAbortController.signal,
        )
      : Promise.resolve(false);
  }

  protected retireTranscriptReads(resume = false): void {
    // Around/bookmark downloads share pane lifetime, never speculative direction.
    this.transcriptReadAbortController.abort();
    this.transcriptReadAbortController = new AbortController();
    this.activeNewerRead?.abort();
    this.activeNewerRead = null;
    if (this.state) {
      retireChatHistoryRead(this.state, resume);
    }
    this.retireCatalogRead(resume);
    this.retireOlderMessagesReads();
  }

  protected resumeTranscriptReads(): void {
    this.resumeCatalogRead();
    const state = this.state;
    const load = state && getChatHistoryLoadState(state);
    if (
      state &&
      load?.phase === "failed" &&
      load.retryable &&
      chatHistoryRequests(state).subscriptionError
    ) {
      // An approval upgrade can fail while its weaker base subscription remains.
      void syncSelectedSessionMessageSubscription(state, { force: true });
    }
    const resumed = state && resumePendingChatHistoryLoad(state);
    if (state && resumed) {
      this.deferSessionHydrationUntilTranscript(
        state.sessionKey,
        resumed.then(() => getChatHistoryLoadState(state).phase === "committed"),
      );
    }
  }

  protected readonly refreshHistory = (options?: { replaceSession?: boolean }) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const catalogKey = parseCatalogSessionKey(state.sessionKey);
    if (catalogKey) {
      void this.loadCatalogSession(catalogKey, false);
      return;
    }
    if (options?.replaceSession || !state.chatRunId) {
      resetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
    }
    this.reconcileWaitingApprovalSnapshot();
    if (chatHistoryRequests(state).subscriptionError) {
      void syncSelectedSessionMessageSubscription(state, { force: true });
    }
    const historyLoad = getChatHistoryLoadState(state);
    const startup = historyLoad.phase === "failed" && historyLoad.startup;
    void refreshPageChat(state, {
      historyLoad: loadChatHistory(state, { startup, supersedeInFlight: true }),
      awaitHistory: true,
      scheduleScroll: false,
      startup,
    });
  };

  protected hasOlderMessages(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    if (parseCatalogSessionKey(state.sessionKey)) {
      return Boolean(this.history.catalogCursor && !this.history.catalogLoading);
    }
    return chatHistoryPageSelector(state, "older") !== null && !state.chatLoading;
  }

  protected async loadNewerMessages(): Promise<boolean> {
    const state = this.state;
    if (!state?.chatHistoryPagination.hasNewer || this.activeNewerRead || state.chatLoading) {
      return false;
    }
    this.retireOlderMessagesReads(false, "newer");
    // Direction reversal retires older intent; boot autofill must not
    // cancel the accepted newer navigation when its window remains short.
    this.historyObserverArmed = false;
    this.historyViewportFillAttempted = true;
    const read = new AbortController();
    this.activeNewerRead = read;
    const ownsConnection = captureChatConnectionOwner(state);
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId;
    const agentId = resolveChatAgentId(state);
    const isCurrent = () =>
      !read.signal.aborted &&
      this.state === state &&
      ownsConnection() &&
      state.sessionKey === sessionKey &&
      state.currentSessionId === sessionId &&
      resolveChatAgentId(state) === agentId;
    try {
      return await this.loadNativeHistoryPackets(state, "newer", true, read.signal, isCurrent);
    } finally {
      if (this.activeNewerRead === read) {
        this.activeNewerRead = null;
      }
    }
  }

  protected resetOlderMessagesViewport(): void {
    this.retireOlderMessagesReads();
    this.historyViewportFillAttempted = false;
    this.resetReplyNavigation();
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = false;
    this.history.olderError = null;
    this.historyInput.reset();
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
      this.historyIntentTimer = null;
    }
    this.olderCursorsSeen.clear();
  }

  protected clearHistoryObserver(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
    this.historyObserverSentinel = null;
  }

  protected syncHistoryObserver(): void {
    const catalogSession = Boolean(this.state && parseCatalogSessionKey(this.state.sessionKey));
    const historyLoading = catalogSession ? this.history.catalogLoading : this.state?.chatLoading;
    if (historyLoading) {
      this.historyObserverArmed = false;
      if (this.history.loadingOlder || this.stagedHistory.load || this.stagedHistory.page) {
        this.retireOlderMessagesReads(true);
      }
    }
    if (
      typeof IntersectionObserver !== "function" ||
      !this.presented ||
      !this.visuallyPresented ||
      document.visibilityState === "hidden" ||
      !this.state?.connected ||
      !this.hasOlderMessages() ||
      (!this.historyObserverArmed && this.historyViewportFillAttempted) ||
      !this.transcript.isPositionSettled ||
      this.transcript.isProgrammaticScroll ||
      this.transcript.isMaintenanceScroll ||
      this.history.loadingOlder ||
      this.historyAutoLoadBlocked
    ) {
      this.clearHistoryObserver();
      return;
    }
    const root = this.transcript.scrollElement;
    const sentinel = this.historySentinel;
    if (!root || !sentinel || !root.contains(sentinel)) {
      this.clearHistoryObserver();
      return;
    }
    if (
      this.historyObserver &&
      this.historyObserver.root === root &&
      this.historyObserverSentinel === sentinel
    ) {
      return;
    }
    this.clearHistoryObserver();
    this.historyObserver = new IntersectionObserver(
      (entries, observer) => {
        // Disconnecting does not cancel queued notifications. Only the current
        // observer may consume this pane's history intent.
        if (
          this.historyObserver !== observer ||
          !this.presented ||
          !this.visuallyPresented ||
          document.visibilityState === "hidden" ||
          !this.transcript.isPositionSettled ||
          !entries.some((entry) => entry.isIntersecting)
        ) {
          return;
        }
        if (this.transcript.isProgrammaticScroll || this.transcript.isMaintenanceScroll) {
          // A layout correction can land in the frame the reader reaches the edge, and an
          // unchanged intersection is never reported again: let the next sync observe anew.
          this.clearHistoryObserver();
          return;
        }
        const readerIntent = this.historyObserverArmed;
        if (!readerIntent) {
          // One page may fill a short boot window; further paging and the
          // prefetch margin belong to reader intent, even if it stays short.
          if (
            this.historyViewportFillAttempted ||
            root.clientHeight <= 0 ||
            root.scrollHeight > root.clientHeight
          ) {
            this.clearHistoryObserver();
            return;
          }
          this.historyViewportFillAttempted = true;
        }
        this.clearHistoryObserver();
        this.historyObserverArmed = false;
        void this.loadOlderMessages(readerIntent);
      },
      // Fire well before the wall: a page fetch takes long enough that a short
      // margin guarantees the user hits the top before the prepend lands. The
      // arming gates above share this constant, so the trigger distance is real.
      { root, rootMargin: `${CHAT_HISTORY_PREFETCH_EDGE_PX}px 0px 0px`, threshold: 0 },
    );
    this.historyObserverSentinel = sentinel;
    this.historyObserver.observe(sentinel);
  }

  protected handleTranscriptScroll(scroll: TranscriptNativeScroll): void {
    const { viewport, delta, programmatic, maintenance } = scroll;
    const renderedSessionKey = this.transcript.renderedSessionKey;
    const stateSessionKey = this.state?.sessionKey;
    if (
      renderedSessionKey &&
      stateSessionKey &&
      areUiSessionKeysEquivalent(renderedSessionKey, stateSessionKey)
    ) {
      saveChatTranscriptReadingPosition(
        this.paneId,
        renderedSessionKey,
        this.state,
        this.transcript,
        viewport,
      );
    }
    // A shrinking scroll range can move the native offset to its new end.
    // Only movement away from that edge can imply reader intent without input.
    const hasUpwardIntent =
      this.presented &&
      this.visuallyPresented &&
      !this.history.loadingOlder &&
      this.hasOlderMessages() &&
      this.transcript.isPositionSettled &&
      !programmatic &&
      !maintenance &&
      delta < 0 &&
      viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight &&
      viewport.scrollTop <= CHAT_HISTORY_PREFETCH_EDGE_PX;
    const newHistoryIntent = hasUpwardIntent && this.consumeHistoryIntent();
    const hasDownwardIntent =
      this.presented &&
      this.visuallyPresented &&
      this.transcript.isPositionSettled &&
      !programmatic &&
      !maintenance &&
      delta > 0 &&
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
        CHAT_HISTORY_PREFETCH_EDGE_PX;
    if (hasDownwardIntent && this.state?.chatHistoryPagination.hasNewer) {
      void this.loadNewerMessages();
    }
    // A failed request stays disarmed until renewed
    // upward intent, preventing request loops without stranding older history.
    if (newHistoryIntent && (this.historyAutoLoadBlocked || !this.historyObserverArmed)) {
      this.historyAutoLoadBlocked = false;
      this.historyObserverArmed = true;
    }
    // A row correction can retire the observer without consuming this gesture's intent.
    if (hasUpwardIntent && this.historyObserverArmed && !this.historyObserver) {
      this.syncHistoryObserver();
    }
    // Preserve the normal at-bottom/new-message bookkeeping while layering
    // history-sentinel arming onto the same scroll event.
    this.state?.handleChatScroll(scroll);
    if (this.state) {
      publishChatSessionProjection(this.state, getChatSessionProjection(this.state));
    }
  }

  protected consumeHistoryIntent(): boolean {
    const consumed = this.historyIntentTimer !== null;
    window.clearTimeout(this.historyIntentTimer ?? undefined);
    this.historyIntentTimer = window.setTimeout(() => {
      this.historyIntentTimer = null;
    }, CHAT_HISTORY_INTENT_IDLE_MS);
    return !consumed;
  }

  protected handleTranscriptHistoryIntent(event: Event): void {
    const direction = this.historyInput.readBoundaryDirection(event, CHAT_HISTORY_PREFETCH_EDGE_PX);
    if (
      !this.presented ||
      !this.visuallyPresented ||
      !this.transcript.isPositionSettled ||
      this.transcript.isProgrammaticScroll ||
      direction === 0 ||
      (direction < 0 &&
        (this.history.loadingOlder || !this.hasOlderMessages() || !this.consumeHistoryIntent()))
    ) {
      return;
    }
    if (direction > 0) {
      // Restored/short windows can be clamped without a native scroll event.
      void this.loadNewerMessages();
      return;
    }
    this.historyAutoLoadBlocked = false;
    if (typeof IntersectionObserver !== "function") {
      void this.loadOlderMessages();
      return;
    }
    this.historyObserverArmed = true;
    this.syncHistoryObserver();
  }

  protected async loadOlderMessages(readerIntent = true): Promise<boolean> {
    if (this.activeOlderLoad) {
      return this.activeOlderLoad;
    }
    this.activeNewerRead?.abort();
    this.activeNewerRead = null;
    if (this.stagedHistory.direction === "newer") {
      this.stagedHistory.controller.abort();
      this.stagedHistory = { controller: new AbortController(), page: null, load: null };
    }
    const load = (async () => {
      // A sparse or overlapping page is cursor progress, not a visible result.
      // Keep boot autofill to one page; reader actions may cross three pages,
      // then yield so a long hidden interval cannot monopolize the connection.
      for (let page = 0; page < (readerIntent ? 3 : 1); page += 1) {
        const loaded = await this.performOlderMessagesLoad(readerIntent);
        if (loaded !== "empty" || !parseCatalogSessionKey(this.state?.sessionKey ?? "")) {
          return loaded !== false;
        }
      }
      return true;
    })();
    this.activeOlderLoad = load;
    try {
      return await load;
    } finally {
      if (this.activeOlderLoad === load) {
        this.activeOlderLoad = null;
      }
    }
  }

  private async performOlderMessagesLoad(readerIntent: boolean): Promise<boolean | "empty"> {
    const state = this.state;
    const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
    if (!state || this.history.loadingOlder || !this.hasOlderMessages()) {
      return false;
    }
    const generation = ++this.olderLoadGeneration;
    const ownsConnection = captureChatConnectionOwner(state);
    const sessionKey = state.sessionKey;
    const agentId = resolveChatAgentId(state);
    const isCurrent = () =>
      generation === this.olderLoadGeneration &&
      this.state === state &&
      ownsConnection() &&
      state.sessionKey === sessionKey &&
      resolveChatAgentId(state) === agentId;
    this.history.olderError = null;
    const read = new AbortController();
    this.activeOlderRead = read;
    // A staged page applies without ever entering the loading state, so the
    // boundary shows no shimmer flash for an instant prepend.
    let prepended = false;
    let visible = true;
    const contributesContent = (messages: unknown[]) =>
      !readerIntent || hasVisibleOlderHistoryPage(state, this.paneId, messages);
    try {
      if (catalogKey) {
        const count = this.history.catalogMessages.length;
        this.history.loadingOlder = true;
        prepended = await this.loadCatalogSession(catalogKey, true);
        visible = contributesContent(
          this.history.catalogMessages.slice(0, this.history.catalogMessages.length - count),
        );
      } else {
        prepended = await this.loadNativeHistoryPackets(
          state,
          "older",
          readerIntent,
          read.signal,
          isCurrent,
        );
      }
    } catch (error) {
      if (isCurrent()) {
        this.recordHistoryPacketFailure(state, "older", error);
      }
    } finally {
      if (this.activeOlderRead === read) {
        this.activeOlderRead = null;
      }
      if (generation === this.olderLoadGeneration) {
        if (!prepended || !this.hasOlderMessages()) {
          this.historyAutoLoadBlocked = this.hasOlderMessages();
        }
        this.history.loadingOlder = false;
      }
    }
    return prepended && !visible && this.hasOlderMessages() ? "empty" : prepended;
  }

  protected async rewindToMessage(entryId: string): Promise<boolean> {
    const state = this.state;
    if (!state) {
      return false;
    }
    const result = await rewindChatHistory(state, entryId, this.chatState.attachmentReads);
    return Boolean(result);
  }

  protected async forkFromMessage(entryId: string): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const state = scope.state;
    const sourceKey = state.sessionKey;
    const agentParams = scopedAgentParamsForSession(state, sourceKey);
    try {
      const result = await state.sessions.forkAtMessage(sourceKey, entryId, agentParams);
      const editorText = result.editorText ?? "";
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !visibleSessionMatches(state, sourceKey, agentParams.agentId)
      ) {
        return;
      }
      if (this.onPaneSessionChange?.(this.paneId, result.sessionKey) === false) {
        return;
      }
      persistChatComposerState(state, result.sessionKey, {
        agentId: parseAgentSessionKey(result.sessionKey)?.agentId,
        draft: editorText,
        mentions: [],
        replyTarget: null,
      });
      preparePaneSessionHandoff(this.context, this.paneId, result.sessionKey, {
        attachments: replaceChatAttachmentsFromEditor([], result.editorAttachments),
        draft: editorText,
      });
    } catch (error) {
      if (
        !this.ownsHeaderOutcomeScope(scope) ||
        !visibleSessionMatches(state, sourceKey, agentParams.agentId)
      ) {
        return;
      }
      state.lastError = formatUiError(error);
      state.chatError = state.lastError;
    }
  }

  protected async switchToBranch(leafEntryId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    await switchChatHistoryBranch(state, leafEntryId);
  }

  protected readonly handleCommandPaletteSlashCommand = (command: string) => {
    const state = this.state;
    if (!state) {
      return;
    }
    state.handleChatDraftChange(command.endsWith(" ") ? command : `${command} `);
  };

  protected announceCommandPaletteTarget(
    onSlashCommand: CommandPaletteTargetDetail["onSlashCommand"],
  ) {
    this.element.dispatchEvent(
      new CustomEvent<CommandPaletteTargetDetail>(COMMAND_PALETTE_TARGET_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          owner: this.element,
          onSlashCommand,
        },
      }),
    );
  }
}
