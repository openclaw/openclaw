import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatSelectionSource,
} from "../../lib/chat/chat-types.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { isSessionRunVisuallyActive } from "../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { buildPendingInputQueueItems, getChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPlacementStartupNoticeProps } from "./chat-view-notices.tsx";
import { createAsyncQuestionPresentation } from "./components/chat-async-question.ts";
import {
  createChatAttachmentDropHandlers,
  stagedAttachmentBytes,
} from "./components/chat-attachments.ts";
import { resolveChatCommentAnchor } from "./components/chat-comment-anchor.ts";
import { getChatComposerState, isChatRunWorking } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import { createChatSelectionAttachment } from "./components/chat-selection-attachment.ts";
import { showChatAnnotationEditor } from "./components/chat-selection-popup.ts";
import type { ChatSwarmProgressProps } from "./components/chat-swarm-progress.solid.tsx";
import type { ChatTaskSuggestionTrayProps } from "./components/chat-task-suggestions.tsx";
import { getTranscriptState, type ChatThreadProps } from "./components/chat-thread-interactions.ts";
import type { ChatTranscript } from "./components/chat-transcript-controller.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
import { chatFailureRunId } from "./run-lifecycle.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
export type ChatProps = Omit<
  ChatThreadProps,
  | "pendingInputs"
  | "runActive"
  | "runWorking"
  | "runFinalizing"
  | "startupLabel"
  | "retryAt"
  | "failureActionsRunId"
  | "questionPrompts"
  | "agents"
  | "queuedMessageAction"
  | "onRetryQueuedMessage"
  | "onDiscardQueuedMessage"
  | "onFocusComposer"
  | "commentAttachments"
  | "commentsDisabled"
  | "onAddToChat"
  | "onCompanionSelection"
  | "onOpenSession"
  | "onSend"
> &
  Omit<ChatComposerProps, "notices" | "footerContent" | "disabled" | "onOpenImage"> &
  ChatDetailsProps &
  ChatTaskSuggestionTrayProps &
  ChatPlacementStartupNoticeProps & {
    onCompanionStageAttachment?: (attachment: ChatAttachment, sourceSessionKey: string) => boolean;
    transcript: ChatTranscript;
    asyncQuestionStorage?:
      | import("../../lib/chat/composer-draft-store.runtime.ts").DurableComposerDraftScope
      | null;
    onAsyncQuestionSubmit?: (
      message: string,
      itemId?: string,
      sourceMessageId?: string,
    ) => Promise<boolean>;
    presented?: PresentationValue;
    historyState?: ChatState;
    awaitingActivity?: boolean;
    environmentStartStatus?: import("../../../../packages/gateway-protocol/src/schema/environments.js").WorkerEnvironmentStartStatus;
    providerPolicyNotice?: ProviderPolicyNotice | null;
    // Resolve after the first pane frame prepares the Solid owner's permission facts.
    readProviderReview?: () => ChatProviderReviewOwner;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
    workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall;
    inlineApproval?: ExecApprovalRequest | null;
    approvalBusy?: boolean;
    approvalCanGrant: boolean;
    approvalErrors?: ReadonlyMap<string, string>;
    onApprovalDecision?: (
      approvalId: string,
      decision: ExecApprovalDecision,
    ) => void | Promise<void>;
    workspaceConflict?: WorkspaceResultConflict;
    onDismissWorkspaceConflict?: () => void;
    swarm?: ChatSwarmProgressProps;
    chatMessageMaxWidth?: string | null;
    showNewMessages?: boolean;
    onScrollToBottom?: (options?: { smooth?: boolean }) => void;
    onRefresh: () => void;
    onDismissError?: () => void;
    agentsList: {
      agents: Array<{
        id: string;
        name?: string;
        identity?: { name?: string; avatarUrl?: string };
      }>;
      defaultId?: string;
    } | null;
    sessionSuggestions?: readonly SessionSuggestion[];
    sessionSuggestionRole?: SessionSharingRole;
    sessionSuggestionBusyIds?: ReadonlySet<string>;
    sessionSuggestionsArchived?: boolean;
    canResolveSessionSuggestions?: boolean;
    onResolveSessionSuggestion?: (
      suggestion: SessionSuggestion,
      resolution: SessionSuggestionResolution,
    ) => void;
    detailsEnabled?: boolean;
  };

// The view frame refreshes on each pane render and the chat-item cache keys the queue by
// identity; reuse the appended copy until the outbox publishes a new array.
const placementQueues = new WeakMap<
  readonly ChatQueueItem[],
  { initialTurn: ChatQueueItem; queue: ChatQueueItem[] }
>();

export function createChatViewFrame(props: ChatProps) {
  // The request session hosts the card; only sourceSessionKey names the requester.
  const approvalSourceSessionKey = props.inlineApproval?.sourceSessionKey;
  const approvalSourceSession = approvalSourceSessionKey
    ? props.sessions?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, approvalSourceSessionKey),
      )
    : undefined;
  const pendingInputs = props.historyState ? getChatPendingInputs(props.historyState) : undefined;
  const displayedPendingInputs = pendingInputs
    ? [...pendingInputs.page.items.filter((input) => !input.queued), ...pendingInputs.queuedInputs]
    : undefined;
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const focusComposer = (selector = ".agent-chat__composer-combobox > textarea") =>
    props.transcript.scrollElement
      ?.closest(".chat")
      ?.querySelector<HTMLElement>(selector)
      ?.focus({ preventScroll: true });
  const openSelectionComment = (
    selection: ChatSelectionSource,
    anchorRect: DOMRect,
    stage: (attachment: ChatAttachment) => boolean,
    onCancel?: () => void,
    selectionContextOnly = false,
  ) => {
    showChatAnnotationEditor({
      paneId: props.paneId,
      anchorRect,
      sourceRange: props.transcript.scrollElement
        ? resolveChatCommentAnchor(props.transcript.scrollElement, selection)?.range
        : undefined,
      comment: "",
      readSignal: props.readSignal,
      onCancel,
      onSave: (comment): boolean => {
        if (props.readSignal?.aborted) {
          return true;
        }
        if (!selectionContextOnly && !uploadsEnabled(props.uploadConfig)) {
          showToast({ message: uploadsDisabledMessage() });
          return false;
        }
        const attachment = createChatSelectionAttachment(
          { ...selection, comment, sessionKey: props.sessionKey },
          { attachmentLimits: props.attachmentLimits, selectionContextOnly },
          stagedAttachmentBytes(props),
        );
        if (!attachment) {
          return false;
        }
        if (!stage(attachment)) {
          releaseChatAttachmentPayloads([attachment]);
          return false;
        }
        return true;
      },
    });
  };
  const canCompose = props.canSend;
  const questionState = getTranscriptState(props.paneId);
  const asyncQuestions = createAsyncQuestionPresentation(questionState, {
    ...props,
    onReopen: (itemId, scope) => {
      const composer = getChatComposerState(props.paneId);
      composer.restoreComposerFocus ||= composer.questionTakeoverActive;
      composer.questionTakeoverActive = false;
      composer.updatePresentation((draft) => {
        draft.activeQuestionKey = JSON.stringify([scope, itemId]);
        draft.questionCollapsed = false;
      });
    },
  });
  const openImage = props.onOpenImage
    ? (item: ImageLightboxItem, requestVersion?: number) =>
        requestVersion === undefined
          ? props.onOpenImage?.(item)
          : props.onOpenImage?.(item, requestVersion)
    : undefined;
  const openImmediateImage = props.onOpenImage
    ? (item: ImageLightboxItem) => openImage?.(item, props.onRequestOpenImage?.())
    : undefined;
  const attachmentDropHandlers = createChatAttachmentDropHandlers({ ...props, canCompose });
  const placementStartup =
    props.placementStartup?.phase === "failed" ? null : props.placementStartup;
  const initialTurn = props.placementStartup?.initialTurn;
  let queue = props.queue;
  if (initialTurn) {
    let cached = placementQueues.get(props.queue);
    if (cached?.initialTurn !== initialTurn) {
      cached = { initialTurn, queue: [...props.queue, initialTurn] };
      placementQueues.set(props.queue, cached);
    }
    queue = cached.queue;
  }
  // Placement is visible work, but does not own an abortable model run yet.
  const runWorking = Boolean(placementStartup) || isChatRunWorking(props);
  const threadProps: ChatThreadProps = {
    ...props,
    asyncQuestions,
    loading: props.loading && !placementStartup,
    streamStartedAt: placementStartup?.startedAt ?? props.streamStartedAt,
    queue,
    initialTurnId: props.placementStartup?.initialTurn?.id,
    pendingInputs: displayedPendingInputs,
    runActive: props.runActive === true,
    runWorking,
    runFinalizing: !isSessionRunVisuallyActive(true, props.startupStatus?.phase),
    startupLabel: chatStartupStatusLabel(
      props.startupStatus,
      placementStartup,
      props.environmentStartStatus,
      (runWorking || props.stream !== null) &&
        props.awaitingActivity !== false &&
        !props.stream?.trim() &&
        props.toolMessages.length === 0,
    ),
    retryAt: props.startupStatus?.phase === "retrying" ? props.startupStatus.retryAt : undefined,
    failureActionsRunId: chatFailureRunId(props.runError, props.selectedSession),
    questionPrompts: props.gatewayQuestionPrompts,
    agents: props.agentsList?.agents,
    onOpenImage: openImage,
    onRequestUpdate: requestUpdate,
    queuedMessageAction: props.placementStartup?.initialTurn
      ? {
          id: props.placementStartup.initialTurn.id,
          label:
            props.placementStartup.action === "check-delivery"
              ? t("chat.queue.checkDelivery")
              : undefined,
          onAction: props.connected ? props.onRetrySessionPlacementStartup : undefined,
        }
      : undefined,
    onRetryQueuedMessage: props.connected && canCompose ? props.onQueueRetry : undefined,
    onDiscardQueuedMessage: props.onQueueRemove,
    onCompanionSelection:
      props.canSend && !props.suggestionComposer && props.onCompanionStageAttachment
        ? (selection, anchorRect) =>
            openSelectionComment(
              selection,
              anchorRect,
              (attachment) =>
                props.onCompanionStageAttachment?.(attachment, props.sessionKey) ?? false,
              undefined,
              true,
            )
        : undefined,
    commentAttachments: props.suggestionComposer ? undefined : props.attachments,
    commentsDisabled: !canCompose || Boolean(props.readSignal?.aborted),
    onAddToChat:
      props.canSend && !props.suggestionComposer && uploadsEnabled(props.uploadConfig)
        ? (selection, anchorRect) =>
            openSelectionComment(
              selection,
              anchorRect,
              (attachment) => {
                if (!props.onAttachmentsChange) {
                  return false;
                }
                props.onAttachmentsChange([
                  ...(props.getAttachments?.() ?? props.attachments ?? []),
                  attachment,
                ]);
                requestUpdate();
                focusComposer();
                return true;
              },
              focusComposer,
            )
        : undefined,
    onOpenSession: props.onSessionSelect,
    // Portaled menus can outlive a render; resolve focus from the current session owner.
    onFocusComposer: () =>
      focusComposer(
        "openclaw-plugin-view[data-plugin-composer], .agent-chat__composer-combobox > textarea",
      ),
  };
  questionState.transcriptRenderContext.onAsyncQuestionSubmit = props.onAsyncQuestionSubmit;
  questionState.transcriptRenderContext.onAsyncQuestionDiscard = asyncQuestions.discard;
  const inputDisplay = selectChatInputDisplay(
    props.messages,
    props.queue,
    displayedPendingInputs ?? [],
  );
  const displayQueue = [
    ...buildPendingInputQueueItems(inputDisplay.queuedInputs),
    ...inputDisplay.queue,
  ];
  const historyLoadState = props.historyState
    ? getChatHistoryLoadState(props.historyState)
    : undefined;
  const historyFailed =
    historyLoadState?.phase === "failed" && historyLoadState.sessionKey === props.sessionKey;
  const transcriptEmpty =
    !runWorking &&
    props.messages.length === 0 &&
    inputDisplay.pendingInputs.length === 0 &&
    inputDisplay.queuedInputs.length === 0 &&
    props.toolMessages.length === 0 &&
    props.streamSegments.length === 0 &&
    !props.stream &&
    queue.length === 0;
  return {
    approvalSourceSession,
    pendingInputs,
    requestUpdate,
    asyncQuestions,
    openImmediateImage,
    attachmentDropHandlers,
    threadProps,
    displayQueue,
    historyLoadState,
    historyFailed,
    transcriptEmpty,
  };
}

export type ChatViewFrame = ReturnType<typeof createChatViewFrame>;
