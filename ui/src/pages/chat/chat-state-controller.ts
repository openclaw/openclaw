import type { ReactiveController, ReactiveControllerHost } from "lit";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { parseStoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { releaseDisplacedChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";
import { resolveChatAttachmentLimits } from "./components/chat-attachment-admission.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import {
  clearSessionWorkspacePreviews,
  clearWorkspaceTimer,
} from "./components/chat-session-workspace-state.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.ts";
import {
  captureChatComposerOwner,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
} from "./composer-persistence-state.ts";
import { ChatComposerPersistence, markChatComposerEdit } from "./composer-persistence.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";
import { cancelChatScroll, scheduleCommittedChatScroll } from "./scroll.ts";

type ChatRenderLifecycleScope = Set<() => void>;

function transcriptSources(state: ChatPageHost): readonly unknown[] {
  return [
    getChatPendingInputs(state)?.page,
    state.chatMessages,
    state.chatToolMessages,
    state.chatStreamSegments,
    state.guardianNotices,
    state.realtimeTalkConversationState.entries,
  ];
}

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private attachmentReadsValue: ChatAttachmentReadLifecycle;
  readonly composerPersistence: ChatComposerPersistence;
  private stateValue: TState | undefined;
  private privateDraftReview: { controller: AbortController; isCurrent: () => boolean } | undefined;
  private previousChatLoading = false;
  private previousTranscriptSources: readonly unknown[] = [];
  private previousChatStream: string | null = null;
  private scrollAfterUpdate = false;
  private scrollContentChangedAfterUpdate = false;
  private forceScrollAfterUpdate = false;
  private readonly cleanups: Array<() => void> = [];
  private renderLifecycleConnected = false;
  private renderLifecycleScope: ChatRenderLifecycleScope | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly onStateChange?: () => void,
    private readonly onQueuedMessageDiscarded?: (item: ChatQueueItem) => void,
  ) {
    this.attachmentReadsValue = new ChatAttachmentReadLifecycle(() =>
      this.stateValue?.requestUpdate?.(),
    );
    this.composerPersistence = new ChatComposerPersistence(() => this.stateValue);
    host.addController(this);
  }

  get attachmentReads(): ChatAttachmentReadLifecycle {
    return this.attachmentReadsValue;
  }

  takeAttachmentReads(): ChatAttachmentReadLifecycle {
    const reads = this.attachmentReadsValue;
    this.attachmentReadsValue = new ChatAttachmentReadLifecycle(() =>
      this.stateValue?.requestUpdate?.(),
    );
    return reads;
  }

  adoptAttachmentReads(reads: ChatAttachmentReadLifecycle, state: TState): void {
    this.attachmentReadsValue.abortReads();
    this.attachmentReadsValue = reads;
    reads.retarget(this.attachmentInputProps(state), () => state.requestUpdate?.());
  }

  attachmentInputProps(state: TState) {
    const reads = this.attachmentReads;
    const readSignal = reads.readSignal;
    return {
      uploadConfig: state.uploadConfig,
      attachmentReads: reads,
      attachments: state.chatAttachments,
      attachmentLimits: resolveChatAttachmentLimits(state.hello?.policy),
      getAttachments: () => state.chatAttachments,
      pendingAttachmentReads: reads.pendingReads,
      getPendingAttachmentReads: () => reads.pendingReads,
      readSignal,
      onPendingReadsChange: (delta: 1 | -1) => {
        if (delta === 1 && readSignal === reads.readSignal) {
          markChatComposerEdit(state);
        }
        reads.updatePending(readSignal, delta);
      },
      onAttachmentsChange: (next: ChatPageHost["chatAttachments"]) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
    };
  }

  createRenderLifecycle(): RenderLifecycle {
    this.cancelRenderLifecycleScope();
    const scope: ChatRenderLifecycleScope = new Set();
    this.renderLifecycleScope = scope;
    return {
      invalidate: () => {
        this.requestUpdateForScope(scope);
      },
      afterCommit: (effect, onCancel) => this.afterCommit(scope, effect, onCancel),
    };
  }

  attach(state: TState) {
    if (this.stateValue && this.stateValue !== state) {
      this.privateDraftReview?.controller.abort();
      disposeSelectedSessionMessageSubscription(this.stateValue);
      releaseChatMediaResourceSubscriber(this.stateValue.requestUpdate);
      this.attachmentReads.abortReads();
      this.composerPersistence.stop();
      cancelChatStreamRenderFrame(this.stateValue);
      cancelChatScroll(this.stateValue);
      stopChatRealtimeTalk(this.stateValue);
    }
    this.stateValue = state;
    this.previousTranscriptSources = transcriptSources(state);
    state.canRestoreComposer = () => this.stateValue === state && this.composerPersistence.active;
    this.previousChatLoading = state.chatLoading;
    this.previousChatStream = state.chatStream;
    const renderLifecycle = state.renderLifecycle;
    state.requestUpdate = () => renderLifecycle.invalidate();
    this.cleanups.push(
      chatOutboxOwner(state).subscribe(state, (item) => {
        if (this.stateValue === state) {
          this.onQueuedMessageDiscarded?.(item);
        }
      }),
    );
    // Retained and hidden panes still own corrections; transport availability
    // must not release their reload protection before Save or Cancel does.
    this.cleanups.push(
      registerControlUiReloadGuard(
        () => this.stateValue !== state || (!state.chatQueuedEdit && !this.hasPrivateDraft(state)),
        () => {
          if (!state.chatQueuedEdit && this.hasPrivateDraft(state)) {
            showToast({
              message: t("chat.privateDraftReload.blocked"),
              actionLabel: t("chat.privateDraftReload.review"),
              onAction: () => void this.reviewPrivateDraft(state),
            });
            return;
          }
          const edit = state.chatQueuedEdit;
          const client = state.client;
          showToast({
            message: t("chat.queue.reloadBlocked"),
            actionLabel: state.reviewQueuedMessageEdit ? t("chat.queue.reviewEdit") : undefined,
            onAction: () => {
              if (
                this.stateValue === state &&
                state.client === client &&
                edit &&
                activeQueuedMessageEdit(state) === edit
              ) {
                state.reviewQueuedMessageEdit?.();
              }
            },
          });
        },
      ),
    );
    const sendChat = state.handleSendChat;
    state.handleSendChat = async (messageOverride, options, submissionAction) => {
      const pending = sendChat(messageOverride, options, submissionAction);
      renderLifecycle.invalidate();
      try {
        return await pending;
      } finally {
        renderLifecycle.invalidate();
      }
    };
    const commitDraftChange = state.handleChatDraftChange;
    state.handleChatDraftChange = (next, mentions) => {
      commitDraftChange(next, mentions);
      this.composerPersistence.schedule();
    };
    const navigateInputHistory = state.handleChatInputHistoryKey;
    state.handleChatInputHistoryKey = (input) => {
      const result = navigateInputHistory(input);
      if (result.handled) {
        this.composerPersistence.schedule();
        // A history recall mutates chatMessage directly; without invalidating,
        // the composer textarea stays empty until an unrelated event re-renders.
        state.renderLifecycle.invalidate();
      }
      return result;
    };
  }

  private hasPrivateComposerInput(state: TState): boolean {
    return (
      isIncognitoComposerScope(state, resolveUiConversationIdentity(state, state.sessionKey)) &&
      Boolean(
        state.chatMessage ||
        state.chatAttachments.length ||
        state.chatGoalDraftMode ||
        state.chatReplyTarget ||
        state.chatMentions?.length ||
        this.attachmentReads.pendingReads,
      )
    );
  }

  private privateFallback(state: TState) {
    return Object.entries(state.chatComposerFallbackByScope).find(([key, fallback]) => {
      const scope = parseStoredChatOutboxScope(key);
      return (
        (fallback.incognito || (scope && isIncognitoComposerScope(state, scope))) &&
        Boolean(
          fallback.message ||
          fallback.attachments.length ||
          fallback.goalMode ||
          fallback.replyTarget ||
          fallback.mentions?.length,
        )
      );
    });
  }

  private hasPrivateDraft(state: TState): boolean {
    return this.hasPrivateComposerInput(state) || Boolean(this.privateFallback(state));
  }

  private async reviewPrivateDraft(state: TState): Promise<void> {
    if (this.stateValue !== state || this.privateDraftReview || !this.hasPrivateDraft(state)) {
      return;
    }
    const owner = captureChatComposerOwner(state);
    const fallback = this.hasPrivateComposerInput(state) ? undefined : this.privateFallback(state);
    const { sessionKey, connectionEpoch } = state;
    const chatMessage = fallback?.[1].message ?? state.chatMessage;
    const chatMentions = fallback ? fallback[1].mentions : state.chatMentions;
    const chatGoalDraftMode = fallback ? fallback[1].goalMode : state.chatGoalDraftMode;
    const chatReplyTarget = fallback ? fallback[1].replyTarget : state.chatReplyTarget;
    const attachments = [...(fallback?.[1].attachments ?? state.chatAttachments)];
    const reads = this.attachmentReads;
    const pendingReads = fallback ? 0 : reads.pendingReads;
    const retryReload = state.captureComposerRecoveryReload?.();
    const review = {
      controller: new AbortController(),
      isCurrent: () =>
        this.stateValue === state &&
        state.client === owner.client &&
        isChatComposerOwnerCurrent(state, owner) &&
        state.sessionKey === sessionKey &&
        state.connectionEpoch === connectionEpoch &&
        (fallback
          ? state.chatComposerFallbackByScope[fallback[0]] === fallback[1]
          : state.chatMessage === chatMessage &&
            state.chatMentions === chatMentions &&
            state.chatGoalDraftMode === chatGoalDraftMode &&
            state.chatReplyTarget === chatReplyTarget &&
            this.attachmentReads === reads &&
            reads.pendingReads === pendingReads &&
            state.chatAttachments.length === attachments.length &&
            attachments.every((attachment, index) => state.chatAttachments[index] === attachment)),
    };
    this.privateDraftReview = review;
    try {
      if (!review.isCurrent() || review.controller.signal.aborted) {
        return;
      }
      const discard = await reviewPrivateComposerDraft({
        text: chatMessage,
        attachments,
        hasGoal: Boolean(chatGoalDraftMode),
        pendingReads,
        isCurrent: review.isCurrent,
        signal: review.controller.signal,
      });
      if (!discard || !review.isCurrent()) {
        return;
      }
      // Discard only this captured composer. Other panes and queued edits still
      // participate in the normal reload guard after the local draft retires.
      if (fallback) {
        const next = { ...state.chatComposerFallbackByScope };
        delete next[fallback[0]];
        state.chatComposerFallbackByScope = next;
      } else {
        reads.abortReads();
        state.chatAttachments = [];
        state.chatGoalDraftMode = null;
        state.chatReplyTarget = null;
        state.handleChatDraftChange("", []);
      }
      const retained = state.captureComposerRecoveryOwner?.()?.retainedAttachmentIds(attachments);
      releaseDisplacedChatAttachmentPayloads(
        attachments.filter((attachment) => !retained?.has(attachment.id)),
        [
          state.chatAttachments,
          ...Object.values(state.chatComposerFallbackByScope).map((item) => item.attachments),
        ],
      );
      state.requestUpdate?.();
      await retryReload?.();
    } catch {
      if (review.isCurrent()) {
        showToast({ message: t("chat.privateDraftReload.unavailable") });
      }
    } finally {
      if (this.privateDraftReview === review) {
        this.privateDraftReview = undefined;
      }
      if (
        !review.isCurrent() &&
        this.stateValue === state &&
        state.client === owner.client &&
        state.sessionKey === sessionKey &&
        this.hasPrivateDraft(state)
      ) {
        showToast({
          message: t("chat.privateDraftReload.changed"),
          actionLabel: t("chat.privateDraftReload.review"),
          onAction: () => void this.reviewPrivateDraft(state),
        });
      }
    }
  }

  addCleanup(cleanup: () => void) {
    this.cleanups.push(cleanup);
  }

  private isRenderLifecycleScopeActive(scope: ChatRenderLifecycleScope): boolean {
    return this.renderLifecycleConnected && this.renderLifecycleScope === scope;
  }

  private requestUpdateForScope(scope: ChatRenderLifecycleScope): boolean {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      return false;
    }
    if (this.privateDraftReview && !this.privateDraftReview.isCurrent()) {
      this.privateDraftReview.controller.abort();
    }
    this.composerPersistence.persistChangedState();
    this.captureRenderLifecycleChanges();
    this.onStateChange?.();
    this.host.requestUpdate();
    return true;
  }

  private cancelRenderLifecycleScope(): void {
    const scope = this.renderLifecycleScope;
    if (!scope) {
      return;
    }
    this.renderLifecycleScope = undefined;
    for (const cancel of scope) {
      cancel();
    }
  }

  private afterCommit(
    scope: ChatRenderLifecycleScope,
    effect: AfterCommitEffect,
    onCancel?: () => void,
  ): () => void {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      onCancel?.();
      return () => undefined;
    }
    let committed = false;
    let cleanup: (() => void) | undefined;
    const complete = () => {
      if (!scope.has(cancel)) {
        return;
      }
      cleanup = undefined;
      scope.delete(cancel);
    };
    const cancel = () => {
      if (!scope.has(cancel)) {
        return;
      }
      scope.delete(cancel);
      try {
        cleanup?.();
      } finally {
        cleanup = undefined;
        if (!committed) {
          onCancel?.();
        }
      }
    };
    scope.add(cancel);
    // Request first so updateComplete represents the render this effect needs.
    if (!this.requestUpdateForScope(scope)) {
      cancel();
      return cancel;
    }
    const completion = this.host.updateComplete;
    void completion.then(() => {
      if (!scope.has(cancel)) {
        return;
      }
      if (!this.isRenderLifecycleScopeActive(scope)) {
        cancel();
        return;
      }
      committed = true;
      try {
        const nextCleanup = effect(complete);
        if (typeof nextCleanup === "function") {
          if (scope.has(cancel) && this.isRenderLifecycleScopeActive(scope)) {
            cleanup = nextCleanup;
          } else {
            nextCleanup();
          }
        } else {
          complete();
        }
      } catch (error) {
        complete();
        throw error;
      }
    }, cancel);
    return cancel;
  }

  private captureRenderLifecycleChanges() {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    const sources = transcriptSources(state);
    const messagesChanged = sources.some(
      (source, index) => this.previousTranscriptSources[index] !== source,
    );
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousTranscriptSources = sources;
    this.previousChatLoading = state.chatLoading;
    this.previousChatStream = state.chatStream;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    this.scrollAfterUpdate = true;
    this.scrollContentChangedAfterUpdate ||= messagesChanged || streamChanged;
    this.forceScrollAfterUpdate ||= loadFinished || streamStarted || !state.chatHasAutoScrolled;
  }

  handleTranscriptResize(): void {
    if (this.stateValue && this.renderLifecycleConnected) {
      scheduleCommittedChatScroll(this.stateValue, false, false, { source: "resize" });
    }
  }

  hostConnected() {
    this.renderLifecycleConnected = true;
    // A lifecycle created while detached must never become active on reconnect.
    this.cancelRenderLifecycleScope();
  }

  hostUpdated() {
    const state = this.stateValue;
    if (!this.scrollAfterUpdate) {
      return;
    }
    const force = this.forceScrollAfterUpdate;
    const contentChanged = this.scrollContentChangedAfterUpdate;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    if (!state) {
      return;
    }
    scheduleCommittedChatScroll(state, force, state.chatHasAutoScrolled, { contentChanged });
  }

  private stopChatEffects() {
    this.privateDraftReview?.controller.abort();
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    if (state) {
      disposeSelectedSessionMessageSubscription(state);
      releaseChatMediaResourceSubscriber(state.requestUpdate);
      cancelChatStreamRenderFrame(state);
      cancelChatScroll(state);
      invalidateImageLightbox(state);
      if (
        state.sidebarContent?.kind === "loading" ||
        state.sidebarContent?.kind === "unavailable"
      ) {
        state.sidebarContent = null;
      }
      clearSessionWorkspacePreviews(state);
      clearWorkspaceTimer(state.sessionWorkspaceState);
      stopChatRealtimeTalk(state);
      state.resetToolStream?.();
    }
  }

  hostDisconnected() {
    this.renderLifecycleConnected = false;
    this.cancelRenderLifecycleScope();
    this.attachmentReads.abortReads();
    // Flush while stateValue still points at the active session. Composer
    // persistence is owned here so controller registration order cannot lose it.
    this.composerPersistence.stop();
    this.stopChatEffects();
    this.stateValue = undefined;
    this.previousTranscriptSources = [];
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
  }
}
