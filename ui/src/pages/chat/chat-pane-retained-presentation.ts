import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { SessionProgressCardRefreshAction } from "../../components/session-progress-card.ts";
import { t } from "../../i18n/index.ts";
import { boardProviderCacheKey } from "../../lib/board/provider.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { runSessionNavigationIntent } from "../../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadChatBranches, retireChatBranchRequests } from "./chat-history-branches.ts";
import {
  chatHistoryRequests,
  getAcceptedChatHistorySession,
  getChatHistoryLoadState,
  isInitialChatHistoryUnavailable,
  setChatError,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { QUEUED_EDIT_RETENTION_CHANGE_EVENT } from "./chat-page-retained-sessions.ts";
import { ChatPaneActiveResources } from "./chat-pane-active-resources.ts";
import { ChatPaneBoard } from "./chat-pane-board.ts";
import type { PaneSessionHandoff } from "./chat-pane-handoff-lifecycle.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import { retirePullRequestRefreshes } from "./chat-pull-request-refresh.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { cancelChatModelRecovery, refreshCurrentChatSessionList } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { refreshChatMetadata } from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message-confirmation-view.tsx";
import { clearSessionWorkspacePreviews } from "./components/chat-session-workspace-state.ts";
import {
  dismissThreadPortals,
  isThreadPresentationFocused,
  resetTranscriptSession,
} from "./components/chat-thread-interactions.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

const COMPOSER_PREFILL_ATTENTION_DURATION_MS = 600;
const COMPOSER_PREFILL_ATTENTION_CLASS = "agent-chat__input--prefill-attention";

/** Owns foreground resources and composer state that follow one retained presentation. */
export abstract class ChatPaneRetainedPresentation extends ChatPaneBoard {
  readonly activeSessionResources = new ChatPaneActiveResources();

  readProgressCardScope() {
    const gateway = this.context.gateway;
    const { client, hello } = gateway.snapshot;
    const target = this.initialProgressCardTarget();
    return {
      store: this.progressCards,
      target,
      client,
      hello,
      options: {
        admitAutomaticRead: () => {
          const current = this.initialProgressCardTarget();
          return (
            this.isConnected &&
            this.context.gateway === gateway &&
            gateway.snapshot.client === client &&
            gateway.snapshot.hello === hello &&
            current?.sessionKey === target?.sessionKey &&
            current?.agentId === target?.agentId
          );
        },
      },
    };
  }

  cacheProgressCard(
    target: ProgressCardGetParams | undefined,
    card: ProgressCard | null | undefined,
  ) {
    const state = this.state;
    if (!target || card === undefined || !state || !this.ownsChatSnapshot(target)) {
      return;
    }
    const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, target);
    if (snapshot && snapshot.progressCard !== card) {
      cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, {
        ...snapshot,
        progressCard: card,
      });
    }
  }
  protected captureProgressCardRefreshAction(): SessionProgressCardRefreshAction | undefined {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return undefined;
    }
    const { state } = scope;
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId;
    const agentId = resolveChatAgentId(state);
    return {
      state: this.progressCardSnapshot.refreshState,
      onRefresh: (card) => {
        if (
          this.isConnectionScopeCurrent(scope) &&
          state.sessionKey === sessionKey &&
          state.currentSessionId === sessionId &&
          resolveChatAgentId(state) === agentId
        ) {
          const target = this.initialProgressCardTarget();
          if (target) {
            this.progressCards.refresh(target, card);
          }
        }
      },
    };
  }

  protected captureProgressCardActions(canWrite: boolean) {
    const state = this.state;
    if (!state) {
      return {};
    }
    const { sessionKey, currentSessionId } = state;
    const agentId = resolveChatAgentId(state);
    const gatewayUrl = state.settings.gatewayUrl;
    const scope = gatewayPresentationScope(this.context.gateway);
    const current = () =>
      this.isConnected &&
      this.presented &&
      this.state === state &&
      state.sessionKey === sessionKey &&
      state.currentSessionId === currentSessionId &&
      resolveChatAgentId(state) === agentId &&
      gatewayPresentationScope(this.context.gateway) === scope;
    return {
      onHideTaskProgress: () => {
        if (!current()) {
          return;
        }
        state.settings = patchSettings({ chatShowTaskProgress: false });
        showToast({
          message: t("chat.sessionDetails.progressHidden"),
          actionLabel: t("common.undo"),
          onAction: () => {
            if (
              loadSettings().gatewayUrl === gatewayUrl &&
              gatewayPresentationScope(this.context.gateway) === scope
            ) {
              patchSettings({ chatShowTaskProgress: true });
            }
          },
        });
      },
      onCollapseTaskProgressChange: (collapsed: boolean) => {
        if (current()) {
          state.settings = patchSettings({ chatCollapseTaskProgress: collapsed });
        }
      },
      onOpenTaskProgressSettings: () => {
        if (current()) {
          this.context.navigate("appearance");
        }
      },
      onClearSavedProgressCard: canWrite
        ? (card: ProgressCard) => {
            if (current() && this.progressCardPresentation?.card === card) {
              this.clearSavedProgressCard(card);
            }
          }
        : undefined,
    };
  }

  private currentSessionArchived: boolean | undefined;
  private archiveFocusOwned = false;

  protected captureArchivePresentationFocus(): void {
    this.archiveFocusOwned = Boolean(
      this.state &&
      this.isCurrentSessionArchived(this.state) &&
      this.currentSessionArchived === false &&
      isThreadPresentationFocused(this.presentationId, this.element),
    );
  }

  protected retireArchivedPresentation(): void {
    const archived = this.state ? this.isCurrentSessionArchived(this.state) : false;
    if (archived && this.currentSessionArchived === false) {
      dismissThreadPortals(this.presentationId, this.element);
      if (this.archiveFocusOwned) {
        this.transcript.scrollElement?.focus({ preventScroll: true });
      }
    }
    this.currentSessionArchived = archived;
  }

  private retainedQueuedEdit = false;

  get hasQueuedMessageEdit(): boolean {
    return Boolean(this.state?.chatQueuedEdit);
  }

  protected syncQueuedEditRetention(): void {
    const retained = this.hasQueuedMessageEdit;
    if (retained !== this.retainedQueuedEdit) {
      this.retainedQueuedEdit = retained;
      this.element.dispatchEvent(new Event(QUEUED_EDIT_RETENTION_CHANGE_EVENT, { bubbles: true }));
    }
  }

  protected abstract syncActiveBindings(): void;
  protected abstract activateComposerPresentation(): void;

  protected reviewQueuedMessageEdit(pageState: ChatPageHost): void {
    const edit = activeQueuedMessageEdit(pageState);
    if (!edit || this.state !== pageState || !this.isConnected) {
      return;
    }
    const client = pageState.client;
    const target = sessionNavigationTarget({
      context: this.context,
      face: "chat",
      sessionKey: edit.sessionKey,
      agentId: edit.agentId,
      exactKey: true,
    });
    runSessionNavigationIntent(this.element, {
      agentId: edit.agentId,
      face: "chat",
      sessionKey: edit.sessionKey,
      commit: () => {
        if (
          this.state !== pageState ||
          pageState.client !== client ||
          this.context.gateway.snapshot.client !== client ||
          activeQueuedMessageEdit(pageState) !== edit
        ) {
          return false;
        }
        this.onFocusPane?.(this.paneId, "review-edit");
        this.context.navigate("chat", target.options);
        return true;
      },
    });
  }

  private progressPresentationSessionKey: string | undefined;
  private progressPresentationReady = false;
  private hiddenProgressCardScope: object | undefined;
  readonly progressVisibility = {
    hiddenCards: new Map<string, { lifetime: object | undefined; revision: number }>(),
  };
  private retainedProgressCard:
    | {
        gatewayScope: object;
        client: ChatPageHost["client"];
        sessionKey: string;
        sessionId: ChatPageHost["currentSessionId"];
        agentId: string | undefined;
        card: ProgressCard;
        lifetime: object | undefined;
        identity: string;
      }
    | undefined;

  protected get progressCardPresentation(): {
    card: ProgressCard;
    lifetime: object | undefined;
    identity: string;
  } | null {
    const state = this.state;
    if (
      !state ||
      state.settings.chatShowTaskProgress === false ||
      !this.presented ||
      this.isCurrentSessionArchived(state) ||
      parseCatalogSessionKey(state.sessionKey)
    ) {
      this.retainedProgressCard = undefined;
      return null;
    }
    const gatewayScope = gatewayPresentationScope(this.context.gateway);
    if (this.hiddenProgressCardScope !== gatewayScope) {
      this.hiddenProgressCardScope = gatewayScope;
      this.progressVisibility.hiddenCards.clear();
    }
    const agentId = resolveUiSelectedSessionAgentId(state);
    const previous = this.retainedProgressCard;
    if (
      previous &&
      (!chatHistoryRequests(state).acceptedHistory ||
        previous.gatewayScope !== gatewayScope ||
        previous.client !== state.client ||
        previous.sessionKey !== state.sessionKey ||
        previous.sessionId !== state.currentSessionId ||
        previous.agentId !== agentId)
    ) {
      this.retainedProgressCard = undefined;
    }
    const progress = this.progressCardSnapshot;
    const card = progress.card;
    const target = this.resolveChatReadTarget();
    if (card && target) {
      this.retainedProgressCard = {
        gatewayScope,
        client: state.client,
        sessionKey: state.sessionKey,
        sessionId: state.currentSessionId,
        agentId,
        card,
        lifetime: progress.lifetime,
        // Global and ordinary sessions can share the progress-card wire key.
        identity: JSON.stringify([target.agentId ?? null, target.sessionKey]),
      };
    } else if (!progress.loading) {
      this.retainedProgressCard = undefined;
    }
    // The X only hides this presentation. The Gateway card remains available to
    // other clients and read-only surfaces; a new card lifetime restores this view.
    const presented = this.retainedProgressCard;
    if (!presented) {
      return null;
    }
    const hidden = this.progressVisibility.hiddenCards.get(presented.identity);
    if (!hidden) {
      return presented;
    }
    if (
      hidden.lifetime
        ? hidden.lifetime === presented.lifetime
        : hidden.revision === presented.card.revision
    ) {
      return null;
    }
    this.progressVisibility.hiddenCards.delete(presented.identity);
    return presented;
  }

  protected readonly clearSavedProgressCard = (card: ProgressCard): void => {
    const target = this.initialProgressCardTarget();
    if (!target) {
      return;
    }
    void this.progressCards
      .dismiss(target, card)
      .catch(() => showToast({ message: t("sessionProgressCard.clearFailed") }));
  };

  protected hideProgressCard(card: ProgressCard): void {
    const presented = this.progressCardPresentation;
    if (!presented || presented.card !== card) {
      return;
    }
    this.progressVisibility.hiddenCards = new Map(this.progressVisibility.hiddenCards).set(
      presented.identity,
      { lifetime: presented.lifetime, revision: card.revision },
    );
  }

  protected override initialProgressCardTarget() {
    const state = this.state;
    if (
      !state ||
      !this.presented ||
      !this.presentation.documentVisible ||
      this.isCurrentSessionArchived(state) ||
      parseCatalogSessionKey(state.sessionKey) ||
      (!this.transcriptReady && !state.currentSessionId && !getAcceptedChatHistorySession(state))
    ) {
      return undefined;
    }
    // Unlike secondary metadata, the progress card determines transcript geometry.
    // Consult preferences only after the pane and its history owner are ready.
    return state.settings.chatShowTaskProgress === false ? undefined : this.resolveChatReadTarget();
  }

  protected get progressCardInitialLoading(): boolean {
    const state = this.state;
    if (!state || state.settings.chatShowTaskProgress === false) {
      return false;
    }
    if (this.progressPresentationSessionKey !== state.sessionKey) {
      this.progressPresentationSessionKey = state.sessionKey;
      this.progressPresentationReady = false;
    }
    const progress = this.progressCardSnapshot;
    if (!progress.loading || this.progressPresentationReady) {
      return false;
    }
    const phase = this.context.gateway.snapshot.phase;
    if (
      !this.isCurrentSessionArchived(state) &&
      !parseCatalogSessionKey(state.sessionKey) &&
      getChatHistoryLoadState(state).phase !== "failed"
    ) {
      if (phase === "connecting" || phase === "starting") {
        return true;
      }
      if (
        state.connected &&
        (!this.presented ||
          !this.presentation.documentVisible ||
          (!this.transcriptReady && !getAcceptedChatHistorySession(state)) ||
          (this.initialProgressCardTarget() && progress.loading && !progress.error))
      ) {
        return true;
      }
    }
    // Only the first read reserves an empty card slot; refreshes retain the mounted card.
    this.progressPresentationReady = true;
    return false;
  }

  protected clearComposerPrefillAttention(): void {
    if (this.composerPrefillAttentionTimer !== null) {
      window.clearTimeout(this.composerPrefillAttentionTimer);
      this.composerPrefillAttentionTimer = null;
    }
    this.composerPrefillAttentionTarget?.classList.remove(COMPOSER_PREFILL_ATTENTION_CLASS);
    this.composerPrefillAttentionTarget = null;
  }

  protected showComposerPrefillAttention(input: HTMLElement): void {
    this.clearComposerPrefillAttention();
    // Force a fresh animation frame when the same mounted composer is prompted again.
    void input.offsetWidth;
    input.classList.add(COMPOSER_PREFILL_ATTENTION_CLASS);
    this.composerPrefillAttentionTarget = input;
    // Reduced motion disables animation events, so timer cleanup owns both modes.
    this.composerPrefillAttentionTimer = window.setTimeout(() => {
      if (this.composerPrefillAttentionTarget === input) {
        this.clearComposerPrefillAttention();
      }
    }, COMPOSER_PREFILL_ATTENTION_DURATION_MS);
  }

  protected confirmConversationReset(): Promise<boolean> {
    const board = this.resolveBoardView();
    const scopeKey = boardProviderCacheKey(this.resolveBoardConversation());
    const pending = this.resetConfirmation.pending;
    if (pending && pending.scopeKey !== scopeKey) {
      this.settleResetConfirmation(false);
    }
    if (!board.hasBoard) {
      return Promise.resolve(true);
    }
    if (this.resetConfirmation.pending) {
      return this.resetConfirmation.pending.promise;
    }
    const { promise, resolve } = createDeferredCore<boolean>();
    this.resetConfirmation.pending = { scopeKey, promise, resolve };
    return promise;
  }

  protected cancelResetConfirmationForSessionChange(): void {
    const pending = this.resetConfirmation.pending;
    if (pending && pending.scopeKey !== boardProviderCacheKey(this.resolveBoardConversation())) {
      this.settleResetConfirmation(false);
    }
  }

  protected settleResetConfirmation(confirmed: boolean): void {
    const pending = this.resetConfirmation.pending;
    if (!pending) {
      return;
    }
    this.resetConfirmation.pending = undefined;
    pending.resolve(confirmed);
  }

  protected renderResetConfirmation() {
    if (!this.resetConfirmation.pending) {
      return null;
    }
    return { onResolve: (confirmed: boolean) => this.settleResetConfirmation(confirmed) };
  }

  protected override activeChanged(active: boolean): void {
    if (!this.isConnected) {
      return;
    }
    this.syncActiveBindings();
    if (active) {
      this.activateComposerPresentation();
    }
    if (active && this.presented && this.state?.chatQueue.length) {
      void refreshCurrentChatSessionList(this.state).catch(() => undefined);
      void resumeStoredChatOutboxes(this.state);
    }
    // Parked transcript snapshots do not rerender; update their component-owned live region now.
    this.element
      .querySelector(".chat-transcript-announcement")
      ?.setAttribute("aria-live", active ? "polite" : "off");
  }

  protected override presentedChanged(presented: boolean): void {
    if (!presented) {
      this.dashboardPresentationActivation = undefined;
      this.retainedProgressCard = undefined;
      this.syncSessionCompanionPresentation(false);
      this.activeSessionResources.sync(null);
      if (this.state) {
        cancelChatModelRecovery(this.state);
      }
      if (this.context) {
        publishChatWorkContext(this.context, this);
      }
    }
    if (!this.isConnected) {
      return;
    }
    if (presented) {
      this.consumeSessionHandoff(this.sessionKey);
      this.activateComposerPresentation();
      this.syncActiveBindings();
      const state = this.state;
      if (state) {
        this.unreadPatchGuard.beginActivation(state.sessionKey);
        void refreshChatMetadata(state, { automatic: true });
        void this.refreshTaskSuggestions({ automatic: true });
      }
      const deferredHydrationActive = this.resumeDeferredSessionHydration();
      if (state && !deferredHydrationActive) {
        this.markSessionRead(selectedChatSessionRow(state));
        if (
          state.connected &&
          this.resolveChatReadTarget() &&
          (state.chatRunId || selectedChatSessionRow(state)?.hasActiveRun)
        ) {
          // Keep the retained transcript visible while reconciling the live run's
          // authoritative start time and activity after a foreground return.
          void loadChatHistory(state, { deferBranches: true });
        }
        if (
          !areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey) ||
          state.chatBranchesConnectionEpoch !== state.connectionEpoch
        ) {
          void loadChatBranches(state);
        }
      }
      this.refreshSwarmRoster();
      void this.refreshSessionPullRequests();
      return;
    }
    if (this.state) {
      retireChatBranchRequests(this.state);
      // Unwatch can cancel an admitted refresh before sync; a later presentation
      // must not inherit a receipt for work its watch no longer owns.
      retirePullRequestRefreshes(this.state);
    }
    this.swarm.hydrator?.dispose();
    this.swarm.hydrator = null;
    this.clearHistoryObserver();
    sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    this.syncActiveBindings();
    this.clearComposerPrefillAttention();
    this.settleResetConfirmation(false);
    this.cancelHeaderRename();
    dismissConfirmedActionPopovers(this.element);
    resetTranscriptSession(this.presentationId, this.element);
    const state = this.state;
    if (state) {
      stopChatRealtimeTalk(state);
      invalidateImageLightbox(state);
      state.sidebarContent = null;
      clearSessionWorkspacePreviews(state);
    }
    // Hidden snapshots stay parked, so the retained live region must be silenced synchronously.
    this.element.querySelector(".chat-transcript-announcement")?.setAttribute("aria-live", "off");
  }

  public prepareForEviction(): void {
    const state = this.state;
    if (!state?.sessionKey) {
      return;
    }
    const persistResult = this.chatState.composerPersistence.persistForRouteSwitchResult();
    if (persistResult.status === "storage-failed") {
      const scope = this.chatState.composerPersistence.scopeForRouteSwitch();
      if (scope) {
        storeChatComposerMemoryFallback(state, scope, {
          message: state.chatMessage,
          mentions: state.chatMentions,
          goalMode: state.chatGoalDraftMode,
          replyTarget: state.chatReplyTarget,
          attachments: state.chatAttachments,
          draftRetry: persistResult,
        });
      }
    }
    // Disconnect transfers the complete composer under its existing revision;
    // a separate unversioned draft would supersede newer edits on remount.
  }

  protected takeSessionHandoff(sessionKey: string): PaneSessionHandoff | null {
    return consumePaneSessionHandoff(this.context, this.paneId, sessionKey);
  }

  protected consumeSessionHandoff(sessionKey: string): void {
    if (!this.state || !sessionKey) {
      return;
    }
    const handoff = this.takeSessionHandoff(sessionKey);
    if (handoff) {
      this.applySessionHandoff(sessionKey, handoff);
    }
  }

  protected applySessionHandoff(sessionKey: string, handoff: PaneSessionHandoff): void {
    const state = this.state;
    if (!state) {
      return;
    }
    if (handoff.composerFallbacks) {
      state.chatComposerFallbackByScope = handoff.composerFallbacks;
    }
    state.chatAttachments = [...handoff.attachments];
    state.chatGoalDraftMode = handoff.goalMode ?? null;
    state.chatReplyTarget = handoff.replyTarget ?? null;
    state.handleChatDraftChange(handoff.draft, handoff.mentions ?? []);
    state.composerDraftChanged?.();
    if (handoff.send) {
      const composer = getChatComposerState(this.presentationId);
      const editRevision = composer.editRevision;
      queueMicrotask(() => {
        // The initial pane applies its gateway snapshot after consuming the handoff.
        if (this.state !== state || state.sessionKey !== sessionKey) {
          return;
        }
        const connectionIsCurrent = captureChatConnectionOwner(state);
        const sessions = state.sessions;
        const attachments = state.chatAttachments;
        const mentions = state.chatMentions;
        const goalMode = state.chatGoalDraftMode;
        const replyTarget = state.chatReplyTarget;
        const presentationOwner = this.headerOutcomeOwner;
        const isCurrent = () =>
          this.state === state &&
          state.sessionKey === sessionKey &&
          connectionIsCurrent() &&
          state.sessions === sessions &&
          this.isConnected &&
          this.active &&
          this.ownsHeaderOutcome(presentationOwner) &&
          // IME and dictation own edits before they commit text to the draft store.
          composer.editRevision === editRevision &&
          state.chatMessage === handoff.draft &&
          state.chatAttachments === attachments &&
          state.chatMentions === mentions &&
          state.chatGoalDraftMode === goalMode &&
          state.chatReplyTarget === replyTarget;
        if (!isCurrent()) {
          return;
        }
        // Catalog continuation already owns a send intent. Join the pane's initial
        // history load; manual input during that load never creates such an intent.
        const load = getChatHistoryLoadState(state);
        const ready =
          load.phase === "in-flight"
            ? load.promise
            : load.phase === "idle" && isInitialChatHistoryUnavailable(state)
              ? loadChatHistory(state, { startup: true, deferBranches: true })
              : Promise.resolve();
        void ready
          .then(() => {
            if (isCurrent() && !isInitialChatHistoryUnavailable(state)) {
              return state.handleSendChat();
            }
            return undefined;
          })
          .catch((error: unknown) => {
            if (isCurrent()) {
              setChatError(state, formatUiError(error));
            }
          });
      });
    }
  }
}
