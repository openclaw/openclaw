import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem, HumanMention } from "../../lib/chat/chat-types.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { parseStoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { releaseDisplacedChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { activeChatRunStartupStatus } from "./chat-run-startup.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { cancelChatStreamRenderFrame, publishChatRunState } from "./chat-state-render.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { resolveChatAttachmentLimits } from "./components/chat-attachment-admission.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { isChatRunWorking } from "./components/chat-composer-state.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import {
  clearSessionWorkspacePreviews,
  clearWorkspaceTimer,
} from "./components/chat-session-workspace-state.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.tsx";
import {
  captureChatComposerOwner,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
} from "./composer-persistence-state.ts";
import { ChatComposerPersistence, markChatComposerEdit } from "./composer-persistence.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import {
  type AfterCommitEffect,
  notifyRenderLifecycleForTest,
  type RenderLifecycle,
} from "./render-lifecycle.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { cancelChatScroll, scheduleCommittedChatScroll } from "./scroll.ts";

type ChatRenderLifecycleScope = Set<() => void>;

function transcriptSources(state: ChatPageHost): readonly unknown[] {
  return [
    getChatPendingInputs(state)?.page,
    state.chatMessages,
    state.chatToolMessages,
    state.chatStreamSegments,
    state.chatReasoning,
    state.guardianNotices,
    state.realtimeTalk.snapshot.realtimeTalkConversationState.entries,
  ];
}

export function createChatState<TState extends ChatPageHost>(
  renderer: {
    invalidate: () => void;
    readonly updateComplete: Promise<unknown>;
  },
  onStateChange?: () => void,
  onQueuedMessageDiscarded?: (item: ChatQueueItem) => void,
) {
  let stateValue: TState | undefined;
  const emptyMentions: readonly HumanMention[] = [];
  const composerDraft = createComposerDraftSource(() => ({
    draft: stateValue?.chatMessage ?? "",
    mentions: stateValue?.chatMentions ?? emptyMentions,
    attachments: stateValue?.chatAttachments ?? [],
    pendingAttachmentReads: attachmentReadsValue.pendingReads,
    goalDraftMode: stateValue?.chatGoalDraftMode,
  }));
  const attachmentChanged = () => {
    if (disposed) {
      return;
    }
    publishComposerDraft();
    stateValue?.requestUpdate?.();
  };
  let attachmentReadsValue = new ChatAttachmentReadLifecycle(attachmentChanged);
  let publishedDraft: ReturnType<typeof composerDraft.read> | undefined;
  const composerPersistence = new ChatComposerPersistence(
    () => stateValue,
    () => {
      if (disposed || !stateValue) {
        return;
      }
      publishComposerDraft();
      onStateChange?.();
    },
  );
  let privateDraftReview: { controller: AbortController; isCurrent: () => boolean } | undefined;
  let previousChatLoading = false;
  let previousTranscriptSources: readonly unknown[] = [];
  let previousChatStream: string | null = null;
  let pendingScroll: { force: boolean; contentChanged: boolean } | undefined;
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let renderLifecycleScope: ChatRenderLifecycleScope | undefined;
  let backgroundRenderFrame: number | undefined;
  let releaseRunPublication: (() => void) | undefined;

  const api = {
    composerPersistence,
    composerDraft,

    get disposed() {
      return disposed;
    },

    dispose(this: void) {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelRenderLifecycleScope();
      attachmentReadsValue.abortReads();
      // Flush while stateValue still points at the active session. Composer
      // persistence is owned here so teardown order cannot lose it.
      composerPersistence.stop();
      stopChatEffects();
      stateValue = undefined;
      previousTranscriptSources = [];
    },

    get attachmentReads(): ChatAttachmentReadLifecycle {
      return attachmentReadsValue;
    },

    projectRunActivity(state: TState | undefined) {
      return state?.connected
        ? {
            client: state.client,
            agentId: resolveChatAgentId(state),
            working: isChatRunWorking({
              runActive: hasDirectSessionRun(state),
              queue: state.chatQueue,
              runStatus: state.chatRunStatus,
              sessionKey: state.sessionKey,
              startupStatus: activeChatRunStartupStatus(state.chatRunStartup),
            }),
            completion: state.chatRunStatus,
          }
        : null;
    },

    takeAttachmentReads(): ChatAttachmentReadLifecycle {
      const reads = attachmentReadsValue;
      attachmentReadsValue = new ChatAttachmentReadLifecycle(attachmentChanged);
      return reads;
    },

    adoptAttachmentReads(reads: ChatAttachmentReadLifecycle, state: TState): void {
      attachmentReadsValue.abortReads();
      attachmentReadsValue = reads;
      reads.retarget(api.attachmentInputProps(state), attachmentChanged);
    },

    attachmentInputProps(state: TState) {
      const reads = attachmentReadsValue;
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
          attachmentChanged();
        },
      };
    },

    createRenderLifecycle(): RenderLifecycle {
      cancelRenderLifecycleScope();
      const scope: ChatRenderLifecycleScope = new Set();
      renderLifecycleScope = scope;
      return {
        invalidate: () => {
          requestUpdateForScope(scope);
        },
        afterCommit: (effect, onCancel) => afterCommit(scope, effect, onCancel),
      };
    },

    attach(state: TState) {
      releaseRunPublication?.();
      if (stateValue && stateValue !== state) {
        privateDraftReview?.controller.abort();
        disposeSelectedSessionMessageSubscription(stateValue);
        releaseChatMediaResourceSubscriber(stateValue.requestUpdate);
        attachmentReadsValue.abortReads();
        composerPersistence.stop();
        cancelChatStreamRenderFrame(stateValue);
        cancelChatScroll(stateValue);
        stopChatRealtimeTalk(stateValue);
      }
      stateValue = state;
      state.composerDraftChanged = () => {
        if (stateValue !== state || disposed) {
          return;
        }
        composerPersistence.persistChangedState();
        publishComposerDraft();
        onStateChange?.();
      };
      publishComposerDraft();
      previousTranscriptSources = transcriptSources(state);
      state.canRestoreComposer = () => stateValue === state && composerPersistence.active;
      previousChatLoading = state.chatLoading;
      previousChatStream = state.chatStream;
      // Publication also owns persistence and activity/retention effects in parked panes.
      releaseRunPublication = chatRunPresentation(state).subscribe(publishStateEffects);
      const renderLifecycle = state.renderLifecycle;
      state.requestUpdate = () => renderLifecycle.invalidate();
      // Queue transitions synchronously update pane retention and shell activity,
      // independently of whether the pane's projected frame is currently observed.
      cleanups.push(subscribeChatOutboxQueue(state, () => onStateChange?.()));
      // Each discarded item has its own completion callback, not a latest-value presentation.
      cleanups.push(
        chatOutboxOwner(state).subscribe(state, (item) => {
          if (stateValue === state) {
            onQueuedMessageDiscarded?.(item);
          }
        }),
      );
      // Retained and hidden panes still own corrections; transport availability
      // must not release their reload protection before Save or Cancel does.
      cleanups.push(
        registerControlUiReloadGuard(
          () => stateValue !== state || (!state.chatQueuedEdit && !hasPrivateDraft(state)),
          () => {
            if (!state.chatQueuedEdit && hasPrivateDraft(state)) {
              showToast({
                message: t("chat.privateDraftReload.blocked"),
                actionLabel: t("chat.privateDraftReload.review"),
                onAction: () => void reviewPrivateDraft(state),
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
                  stateValue === state &&
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
        composerPersistence.schedule();
        publishComposerDraft();
      };
      const navigateInputHistory = state.handleChatInputHistoryKey;
      state.handleChatInputHistoryKey = (input) => {
        const result = navigateInputHistory(input);
        if (result.handled) {
          composerPersistence.schedule();
          publishComposerDraft();
        }
        return result;
      };
    },

    addCleanup(cleanup: () => void) {
      cleanups.push(cleanup);
    },

    requestBackgroundUpdate(): void {
      if (renderLifecycleScope) {
        requestUpdateForScope(renderLifecycleScope, true);
      }
    },

    handleTranscriptResize(): void {
      if (stateValue && !disposed) {
        scheduleCommittedChatScroll(stateValue, false, false, { source: "resize" });
      }
    },

    commitRender() {
      if (renderLifecycleScope && isRenderLifecycleScopeActive(renderLifecycleScope)) {
        notifyRenderLifecycleForTest(renderer, "commit");
      }
      const pending = pendingScroll;
      pendingScroll = undefined;
      if (stateValue && pending) {
        scheduleCommittedChatScroll(stateValue, pending.force, stateValue.chatHasAutoScrolled, {
          contentChanged: pending.contentChanged,
        });
      }
    },

    prepareRender() {
      // A render consumes both deferred producers before their next frame.
      cancelBackgroundRender();
      const state = stateValue;
      if (state?.chatStreamRenderFrame != null) {
        cancelChatStreamRenderFrame(state);
        publishChatRunState(state);
      }
      // Field projections can schedule a frame without a page-wide invalidation.
      captureRenderLifecycleChanges();
    },
  };
  return api;

  function publishComposerDraft() {
    publishedDraft = composerDraft.read();
    composerDraft.publish();
  }

  function hasPrivateComposerInput(state: TState): boolean {
    return (
      isIncognitoComposerScope(state, resolveUiConversationIdentity(state, state.sessionKey)) &&
      Boolean(
        state.chatMessage ||
        state.chatAttachments.length ||
        state.chatGoalDraftMode ||
        state.chatReplyTarget ||
        state.chatMentions?.length ||
        attachmentReadsValue.pendingReads,
      )
    );
  }

  function privateFallback(state: TState) {
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

  function hasPrivateDraft(state: TState): boolean {
    return hasPrivateComposerInput(state) || Boolean(privateFallback(state));
  }

  async function reviewPrivateDraft(state: TState): Promise<void> {
    if (stateValue !== state || privateDraftReview || !hasPrivateDraft(state)) {
      return;
    }
    const owner = captureChatComposerOwner(state);
    const fallback = hasPrivateComposerInput(state) ? undefined : privateFallback(state);
    const { sessionKey, connectionEpoch } = state;
    const chatMessage = fallback?.[1].message ?? state.chatMessage;
    const chatMentions = fallback ? fallback[1].mentions : state.chatMentions;
    const chatGoalDraftMode = fallback ? fallback[1].goalMode : state.chatGoalDraftMode;
    const chatReplyTarget = fallback ? fallback[1].replyTarget : state.chatReplyTarget;
    const attachments = [...(fallback?.[1].attachments ?? state.chatAttachments)];
    const reads = attachmentReadsValue;
    const pendingReads = fallback ? 0 : reads.pendingReads;
    const retryReload = state.captureComposerRecoveryReload?.();
    const review = {
      controller: new AbortController(),
      isCurrent: () =>
        stateValue === state &&
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
            attachmentReadsValue === reads &&
            reads.pendingReads === pendingReads &&
            state.chatAttachments.length === attachments.length &&
            attachments.every((attachment, index) => state.chatAttachments[index] === attachment)),
    };
    privateDraftReview = review;
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
      if (privateDraftReview === review) {
        privateDraftReview = undefined;
      }
      if (
        !review.isCurrent() &&
        stateValue === state &&
        state.client === owner.client &&
        state.sessionKey === sessionKey &&
        hasPrivateDraft(state)
      ) {
        showToast({
          message: t("chat.privateDraftReload.changed"),
          actionLabel: t("chat.privateDraftReload.review"),
          onAction: () => void reviewPrivateDraft(state),
        });
      }
    }
  }

  function isRenderLifecycleScopeActive(scope: ChatRenderLifecycleScope): boolean {
    return !disposed && renderLifecycleScope === scope;
  }

  function cancelBackgroundRender(): void {
    if (backgroundRenderFrame !== undefined) {
      cancelAnimationFrame(backgroundRenderFrame);
      backgroundRenderFrame = undefined;
    }
  }

  function publishStateEffects(): void {
    if (privateDraftReview && !privateDraftReview.isCurrent()) {
      privateDraftReview.controller.abort();
    }
    composerPersistence.persistChangedState();
    // Legacy restore writers still signal through the page owner. Ordinary
    // stream updates must not invalidate the independent composer projection.
    // Explicit mutation hooks above also cover changes within retained arrays.
    const draft = composerDraft.read();
    if (
      !publishedDraft ||
      draft.draft !== publishedDraft.draft ||
      draft.mentions !== publishedDraft.mentions ||
      draft.attachments !== publishedDraft.attachments ||
      draft.pendingAttachmentReads !== publishedDraft.pendingAttachmentReads ||
      draft.goalDraftMode !== publishedDraft.goalDraftMode
    ) {
      publishComposerDraft();
    }
    onStateChange?.();
  }

  function requestUpdateForScope(scope: ChatRenderLifecycleScope, background = false): boolean {
    if (!isRenderLifecycleScopeActive(scope)) {
      return false;
    }
    publishStateEffects();
    captureRenderLifecycleChanges();
    notifyRenderLifecycleForTest(renderer, "invalidate");
    // Only background producers opt in. Draft persistence and scroll ownership
    // are captured above, and transcript changes still commit before paint.
    if (
      background &&
      !pendingScroll &&
      globalThis.document?.visibilityState !== "hidden" &&
      typeof globalThis.requestAnimationFrame === "function"
    ) {
      backgroundRenderFrame ??= requestAnimationFrame(() => {
        backgroundRenderFrame = undefined;
        if (isRenderLifecycleScopeActive(scope)) {
          renderer.invalidate();
        }
      });
    } else {
      cancelBackgroundRender();
      renderer.invalidate();
    }
    return true;
  }

  function cancelRenderLifecycleScope(): void {
    cancelBackgroundRender();
    const scope = renderLifecycleScope;
    if (!scope) {
      return;
    }
    renderLifecycleScope = undefined;
    for (const cancel of scope) {
      cancel();
    }
  }

  function afterCommit(
    scope: ChatRenderLifecycleScope,
    effect: AfterCommitEffect,
    onCancel?: () => void,
  ): () => void {
    if (!isRenderLifecycleScopeActive(scope)) {
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
    if (!requestUpdateForScope(scope)) {
      cancel();
      return cancel;
    }
    const completion = renderer.updateComplete;
    void completion.then(() => {
      if (!scope.has(cancel)) {
        return;
      }
      if (!isRenderLifecycleScopeActive(scope)) {
        cancel();
        return;
      }
      committed = true;
      try {
        const nextCleanup = effect(complete);
        if (typeof nextCleanup === "function") {
          if (scope.has(cancel) && isRenderLifecycleScopeActive(scope)) {
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

  function captureRenderLifecycleChanges() {
    const state = stateValue;
    if (!state) {
      return;
    }
    const sources = transcriptSources(state);
    const messagesChanged = sources.some(
      (source, index) => previousTranscriptSources[index] !== source,
    );
    const streamChanged = previousChatStream !== state.chatStream;
    const loadingChanged = previousChatLoading !== state.chatLoading;
    const loadFinished = previousChatLoading && !state.chatLoading;
    const streamStarted = previousChatStream == null && typeof state.chatStream === "string";
    previousTranscriptSources = sources;
    previousChatLoading = state.chatLoading;
    previousChatStream = state.chatStream;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    pendingScroll = {
      contentChanged: pendingScroll?.contentChanged || messagesChanged || streamChanged,
      force: pendingScroll?.force || loadFinished || streamStarted || !state.chatHasAutoScrolled,
    };
  }

  function stopChatEffects() {
    releaseRunPublication?.();
    releaseRunPublication = undefined;
    privateDraftReview?.controller.abort();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    const state = stateValue;
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
}
