import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  parseStoredChatOutboxScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
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
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import { clearSessionWorkspacePreviews } from "./components/chat-session-workspace-state.ts";
import { clearSessionWorkspaceTimers } from "./components/chat-session-workspace.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.ts";
import {
  captureChatComposerOwner,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
} from "./composer-persistence-state.ts";
import type { ChatComposerPersistResult } from "./composer-persistence-state.ts";
import { ChatComposerPersistence, markChatComposerEdit } from "./composer-persistence.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";
import { cancelChatScroll, lockChatScroll, scheduleCommittedChatScroll } from "./scroll.ts";

type ChatRenderLifecycleScope = {
  cancellations: Set<() => void>;
};

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private attachmentReadsValue: ChatAttachmentReadLifecycle;
  private readonly composerPersistence: ChatComposerPersistence;
  private stateValue: TState | undefined;
  private privateDraftReview: { controller: AbortController; isCurrent: () => boolean } | undefined;
  private previousChatLoading = false;
  private previousChatMessages: unknown[] = [];
  private previousPendingInputs: ChatPendingInputsPage | undefined;
  private inputScope: { sessionKey: string; sessionId: string | null } | undefined;
  private readonly seenInputKeys = new Set<string>();
  private previousChatToolMessages: Record<string, unknown>[] = [];
  private previousChatStreamSegments: ChatPageHost["chatStreamSegments"] = [];
  private previousGuardianNotices: ChatPageHost["guardianNotices"] = [];
  private previousChatStream: string | null = null;
  private previousRealtimeConversation: ChatPageHost["realtimeTalkConversation"] = [];
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

  get state(): TState | undefined {
    return this.stateValue;
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
      attachmentReads: reads,
      attachments: state.chatAttachments,
      attachmentLimits: state.hello?.policy?.attachments,
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
    const scope: ChatRenderLifecycleScope = {
      cancellations: new Set(),
    };
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
    if (this.stateValue !== state) {
      this.inputScope = undefined;
      this.seenInputKeys.clear();
    }
    this.stateValue = state;
    const pendingInputs = getChatPendingInputs(state)?.page;
    this.observeInputArrivals(state, pendingInputs);
    this.previousPendingInputs = pendingInputs;
    state.canRestoreComposer = () => this.stateValue === state && this.composerPersistence.active;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStreamSegments = state.chatStreamSegments;
    this.previousGuardianNotices = state.guardianNotices;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
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
    for (const cancel of scope.cancellations) {
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
    let active = true;
    let committed = false;
    let cleanup: (() => void) | undefined;
    const complete = () => {
      if (!active) {
        return;
      }
      active = false;
      cleanup = undefined;
      scope.cancellations.delete(cancel);
    };
    const cancel = () => {
      if (!active) {
        return;
      }
      active = false;
      scope.cancellations.delete(cancel);
      try {
        cleanup?.();
      } finally {
        cleanup = undefined;
        if (!committed) {
          onCancel?.();
        }
      }
    };
    scope.cancellations.add(cancel);
    // Request first so updateComplete represents the render this effect needs.
    if (!this.requestUpdateForScope(scope)) {
      cancel();
      return cancel;
    }
    const completion = this.host.updateComplete;
    void completion.then(() => {
      if (!active) {
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
          if (active && this.isRenderLifecycleScopeActive(scope)) {
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

  private observeInputArrivals(
    state: TState,
    pendingInputs: ChatPendingInputsPage | undefined,
  ): boolean {
    const sessionId = state.currentSessionId ?? null;
    const changedScope =
      this.inputScope?.sessionKey !== state.sessionKey || this.inputScope?.sessionId !== sessionId;
    if (changedScope) {
      this.inputScope = { sessionKey: state.sessionKey, sessionId };
      this.seenInputKeys.clear();
    }
    // Only the local outbox proves submission in this viewer. Authorship alone
    // cannot distinguish a send from another browser signed in as the same user.
    for (const queued of state.chatQueue) {
      if (queued.sendRunId) {
        this.seenInputKeys.add("send:" + queued.sendRunId);
      }
    }
    if (
      !changedScope &&
      this.previousChatMessages === state.chatMessages &&
      this.previousPendingInputs === pendingInputs
    ) {
      return false;
    }
    let remoteInputArrived = false;
    const observe = (message: unknown, sendId?: string) => {
      const identity = readSessionMessageIdentity(message, { clientRunId: sendId });
      if (identity?.role !== "user") {
        return;
      }
      const key = identity.sendId
        ? "send:" + identity.sendId
        : identity.id
          ? "entry:" + identity.id
          : null;
      if (!key || this.seenInputKeys.has(key)) {
        return;
      }
      // Retain receipt identity through custody-to-history gaps and replay;
      // retire this presentation cache with its pane or physical conversation.
      this.seenInputKeys.add(key);
      // Persisted rows for this browser's own speech keep the live caption's identity.
      const entryId = identity.id;
      if (
        entryId &&
        state.realtimeTalkConversation.some((entry) => entry.transcriptId === entryId)
      ) {
        return;
      }
      remoteInputArrived ||= !changedScope && state.chatHasAutoScrolled;
    };
    state.chatMessages.forEach((message) => observe(message));
    pendingInputs?.items.forEach((input) => observe(input.message, input.runId));
    return remoteInputArrived;
  }

  private captureRenderLifecycleChanges() {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    const pendingInputs = getChatPendingInputs(state)?.page;
    const remoteInputArrived = this.observeInputArrivals(state, pendingInputs);
    const messagesChanged =
      this.previousPendingInputs !== pendingInputs ||
      this.previousChatMessages !== state.chatMessages ||
      this.previousChatToolMessages !== state.chatToolMessages ||
      this.previousChatStreamSegments !== state.chatStreamSegments ||
      this.previousGuardianNotices !== state.guardianNotices ||
      this.previousRealtimeConversation !== state.realtimeTalkConversation;
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousPendingInputs = pendingInputs;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStreamSegments = state.chatStreamSegments;
    this.previousGuardianNotices = state.guardianNotices;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    if (remoteInputArrived) {
      lockChatScroll(state, "remote-input");
    }
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

  restoreComposer(options: { preserveCurrent?: boolean } = {}) {
    this.composerPersistence.restore(options);
  }

  startComposerPersistence() {
    this.composerPersistence.start();
  }

  pauseComposerPersistence() {
    this.composerPersistence.stop();
  }

  persistComposerForEviction(): ChatComposerPersistResult {
    return this.composerPersistence.persistForRouteSwitchResult();
  }

  composerScopeForEviction(): StoredChatOutboxScope | null {
    return this.composerPersistence.scopeForRouteSwitch();
  }

  get durableComposerScope() {
    return this.composerPersistence.durableScope;
  }

  get composerDraftRevision(): number {
    return this.composerPersistence.draftRevision;
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
      clearSessionWorkspaceTimers(state);
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
    this.inputScope = undefined;
    this.seenInputKeys.clear();
    this.previousPendingInputs = undefined;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
  }
}
