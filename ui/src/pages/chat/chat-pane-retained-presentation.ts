import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import "../../components/modal-dialog.ts";
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
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { loadChatBranches, retireChatBranchRequests } from "./chat-history-branches.ts";
import {
  chatHistoryRequests,
  getAcceptedChatHistorySession,
  getChatHistoryLoadState,
  isInitialChatHistoryUnavailable,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { QUEUED_EDIT_RETENTION_CHANGE_EVENT } from "./chat-page-retained-sessions.ts";
import { ChatPaneBoard } from "./chat-pane-board.ts";
import { consumePaneSessionHandoff, type PaneSessionHandoff } from "./chat-pane-shared.ts";
import { retirePullRequestRefreshes } from "./chat-pull-request-refresh.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { refreshChatMetadata } from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message.ts";
import { clearSessionWorkspacePreviews } from "./components/chat-session-workspace-state.ts";
import { resetTaskDetail } from "./components/chat-task-detail-state.ts";
import {
  dismissThreadPortals,
  isThreadPresentationFocused,
  resetTranscriptSession,
} from "./components/chat-thread-interactions.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";

const COMPOSER_PREFILL_ATTENTION_DURATION_MS = 600;
const COMPOSER_PREFILL_ATTENTION_CLASS = "agent-chat__input--prefill-attention";

/** Owns foreground resources and composer state that follow one retained presentation. */
export abstract class ChatPaneRetainedPresentation extends ChatPaneBoard {
  protected captureProgressCardRefreshAction(): SessionProgressCardRefreshAction | undefined {
    const state = this.state;
    const scope = this.captureConnectionScope();
    if (!state || !scope) {
      return undefined;
    }
    const sessionKey = state.sessionKey;
    const sessionId = state.currentSessionId;
    const agentId = resolveChatAgentId(state);
    return {
      state: this.progressCard.refreshState,
      onRefresh: (card) => {
        const current = this.state;
        if (
          current &&
          this.isConnectionScopeCurrent(scope) &&
          current.sessionKey === sessionKey &&
          current.currentSessionId === sessionId &&
          resolveChatAgentId(current) === agentId
        ) {
          this.progressCard.refresh(card);
        }
      },
    };
  }

  private currentSessionArchived: boolean | undefined;
  private archiveFocusOwned = false;

  protected captureArchivePresentationFocus(): void {
    this.archiveFocusOwned = Boolean(
      this.state &&
      this.isCurrentSessionArchived(this.state) &&
      this.currentSessionArchived === false &&
      isThreadPresentationFocused(this.presentationId, this),
    );
  }

  protected retireArchivedPresentation(): void {
    const archived = this.state ? this.isCurrentSessionArchived(this.state) : false;
    if (archived && this.currentSessionArchived === false) {
      dismissThreadPortals(this.presentationId, this);
      if (this.archiveFocusOwned) {
        this.querySelector<HTMLElement>(".chat-thread")?.focus({ preventScroll: true });
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
      this.dispatchEvent(new Event(QUEUED_EDIT_RETENTION_CHANGE_EVENT, { bubbles: true }));
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
    runSessionNavigationIntent(this, {
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
    const card = this.progressCard.card;
    const target = this.resolveChatReadTarget();
    if (card && target) {
      this.retainedProgressCard = {
        gatewayScope,
        client: state.client,
        sessionKey: state.sessionKey,
        sessionId: state.currentSessionId,
        agentId,
        card,
        lifetime: this.progressCard.lifetime,
        // Global and ordinary sessions can share the progress-card wire key.
        identity: JSON.stringify([target.agentId ?? null, target.sessionKey]),
      };
    } else if (!this.progressCard.loading) {
      this.retainedProgressCard = undefined;
    }
    // Reconnect retires read admission, not the mounted card's disclosure state.
    return this.retainedProgressCard ?? null;
  }

  protected override initialProgressCardTarget() {
    const state = this.state;
    if (
      !state?.connected ||
      !this.presented ||
      document.visibilityState === "hidden" ||
      this.isCurrentSessionArchived(state) ||
      parseCatalogSessionKey(state.sessionKey) ||
      (!this.transcriptReady && !getAcceptedChatHistorySession(state))
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
    if (this.progressPresentationReady) {
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
          document.visibilityState === "hidden" ||
          (!this.transcriptReady && !getAcceptedChatHistorySession(state)) ||
          (this.initialProgressCardTarget() &&
            this.progressCard.loading &&
            !this.progressCard.error))
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
    const pending = this.resetConfirmation;
    if (pending && pending.scopeKey !== scopeKey) {
      this.settleResetConfirmation(false);
    }
    if (!board.hasBoard) {
      return Promise.resolve(true);
    }
    if (this.resetConfirmation) {
      return this.resetConfirmation.promise;
    }
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((next) => {
      resolve = next;
    });
    this.resetConfirmation = { scopeKey, promise, resolve };
    this.resetConfirmationOpen = true;
    return promise;
  }

  protected cancelResetConfirmationForSessionChange(): void {
    const pending = this.resetConfirmation;
    if (pending && pending.scopeKey !== boardProviderCacheKey(this.resolveBoardConversation())) {
      this.settleResetConfirmation(false);
    }
  }

  protected settleResetConfirmation(confirmed: boolean): void {
    const pending = this.resetConfirmation;
    if (!pending) {
      return;
    }
    this.resetConfirmation = undefined;
    this.resetConfirmationOpen = false;
    pending.resolve(confirmed);
  }

  protected renderResetConfirmation() {
    if (!this.resetConfirmationOpen) {
      return nothing;
    }
    const title = t("chat.board.resetTitle");
    const description = t("chat.board.resetDescription");
    return html`
      <openclaw-modal-dialog
        label=${title}
        description=${description}
        @modal-cancel=${() => this.settleResetConfirmation(false)}
      >
        <div class="exec-approval-card board-reset-confirmation">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">${title}</div>
              <div class="exec-approval-sub">${description}</div>
            </div>
          </div>
          <div class="exec-approval-actions">
            <button
              class="btn primary"
              type="button"
              @click=${() => this.settleResetConfirmation(true)}
            >
              ${t("common.confirm")}
            </button>
            <button
              class="btn"
              type="button"
              autofocus
              @click=${() => this.settleResetConfirmation(false)}
            >
              ${t("common.cancel")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
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
    this.querySelector(".chat-transcript-announcement")?.setAttribute(
      "aria-live",
      active ? "polite" : "off",
    );
  }

  protected override presentedChanged(presented: boolean): void {
    if (!presented) {
      this.dashboardPresentationActivation = undefined;
      this.retainedProgressCard = undefined;
    }
    if (!this.isConnected) {
      return;
    }
    if (presented) {
      this.minutePoll.start();
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
      }
      if (
        state &&
        !deferredHydrationActive &&
        (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey) ||
          state.chatBranchesConnectionEpoch !== state.connectionEpoch)
      ) {
        void loadChatBranches(state);
      }
      this.refreshSwarmRoster();
      void this.refreshSessionPullRequests();
      return;
    }
    this.minutePoll.stop();
    if (this.state) {
      retireChatBranchRequests(this.state);
      // Unwatch can cancel an admitted refresh before sync; a later presentation
      // must not inherit a receipt for work its watch no longer owns.
      retirePullRequestRefreshes(this.state);
    }
    this.swarmHydrator?.dispose();
    this.swarmHydrator = null;
    this.clearHistoryObserver();
    sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    this.syncActiveBindings();
    this.clearComposerPrefillAttention();
    this.settleResetConfirmation(false);
    this.cancelHeaderRename();
    dismissConfirmedActionPopovers(this);
    resetTranscriptSession(this.presentationId, this);
    const state = this.state;
    if (state) {
      stopChatRealtimeTalk(state);
      invalidateImageLightbox(state);
      resetTaskDetail(state);
      state.sidebarContent = null;
      clearSessionWorkspacePreviews(state);
      state.requestUpdate?.();
    }
    this.querySelector(".chat-transcript-announcement")?.setAttribute("aria-live", "off");
  }

  public prepareForEviction(): void {
    const state = this.state;
    if (!state?.sessionKey) {
      return;
    }
    const persistResult = this.chatState.persistComposerForEviction();
    if (persistResult.status === "storage-failed") {
      const scope = this.chatState.composerScopeForEviction();
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
    state.requestUpdate?.();
    if (handoff.send) {
      const composer = getChatComposerState(this.presentationId);
      const editRevision = composer.editRevision;
      queueMicrotask(() => {
        // The initial pane applies its gateway snapshot after consuming the handoff.
        if (this.state !== state || state.sessionKey !== sessionKey) {
          return;
        }
        const client = state.client;
        const connectionEpoch = state.connectionEpoch;
        const sessions = state.sessions;
        const attachments = state.chatAttachments;
        const mentions = state.chatMentions;
        const goalMode = state.chatGoalDraftMode;
        const replyTarget = state.chatReplyTarget;
        const presentationOwner = this.headerOutcomeOwner;
        const isCurrent = () =>
          this.state === state &&
          state.sessionKey === sessionKey &&
          state.connected &&
          state.client === client &&
          state.connectionEpoch === connectionEpoch &&
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
              state.requestUpdate?.();
            }
          });
      });
    }
  }
}
