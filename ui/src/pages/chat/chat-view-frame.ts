import { createMemo, merge } from "solid-js";
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
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRunVisuallyActive } from "../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  buildPendingInputQueueItems,
  dismissChatPendingInputs,
  getChatPendingInputs,
  isPendingInputDismissHidden,
} from "./chat-pending-inputs.ts";
import type { ChatProviderReviewOwner } from "./chat-provider-review-controller.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { isChatRunWorking } from "./chat-run-working.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPlacementStartupNoticeProps } from "./chat-view-notices.tsx";
import type { AsyncQuestionPresentation } from "./components/chat-async-question.types.ts";
import {
  createChatAttachmentDropHandlers,
  stagedAttachmentBytes,
} from "./components/chat-attachments.ts";
import { resolveChatCommentAnchor } from "./components/chat-comment-anchor.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import { createChatSelectionAttachment } from "./components/chat-selection-attachment.ts";
import { showChatAnnotationEditor } from "./components/chat-selection-popup.tsx";
import type { SidebarContent, SidebarOpenResult } from "./components/chat-sidebar-content-types.ts";
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
  | "onDismissPendingInput"
  | "onFocusComposer"
  | "commentAttachments"
  | "commentsDisabled"
  | "onAddToChat"
  | "onCompanionSelection"
  | "onOpenSession"
  | "onSend"
  | "onOpenSidebar"
> &
  Omit<
    ChatComposerProps,
    | "notices"
    | "footerContent"
    | "disabled"
    | "onOpenImage"
    | "mobileActivityPills"
    | "mobileApprovalContent"
    | "onOpenSidebar"
  > &
  ChatDetailsProps &
  ChatTaskSuggestionTrayProps &
  ChatPlacementStartupNoticeProps & {
    onOpenSidebar?: (content: SidebarContent) => SidebarOpenResult;
    onConversationFrameRef?: (element: HTMLElement) => void | (() => void);
    onFooterElementRef?: (element: HTMLElement) => void | (() => void);
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
    getQueue?: () => readonly ChatQueueItem[];
    historyState?: ChatState;
    /** Session access presentation for dismissing retired inputs; independent of model availability. */
    canDismissPendingInputs?: boolean;
    awaitingActivity?: boolean;
    environmentStartStatus?: import("../../../../packages/gateway-protocol/src/schema/environments.js").WorkerEnvironmentStartStatus;
    providerPolicyNotice?: ProviderPolicyNotice | null;
    // Resolve after the first pane frame prepares the Solid owner's permission facts.
    readProviderReview?: () => ChatProviderReviewOwner | undefined;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
    workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall;
    inlineApproval?: ExecApprovalRequest | null;
    approvalBusy?: boolean;
    approvalCanGrant: boolean;
    approvalErrors?: ReadonlyMap<string, string>;
    approvalNodeNames?: ReadonlyMap<string, string>;
    approvalPendingCount?: number;
    onOpenPendingApprovals?: () => void;
    onApprovalDecision?: (
      approvalId: string,
      decision: ExecApprovalDecision,
    ) => void | Promise<void>;
    workspaceConflict?: WorkspaceResultConflict;
    onDismissWorkspaceConflict?: () => void;
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

export function createChatViewFrame(
  props: ChatProps,
  focusComposer: (replacement?: boolean) => void,
  asyncQuestions: AsyncQuestionPresentation,
) {
  // The request session hosts the card; only sourceSessionKey names the requester.
  const approvalSourceSessionKey = props.inlineApproval?.sourceSessionKey;
  const approvalSourceSession = approvalSourceSessionKey
    ? props.sessions?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, approvalSourceSessionKey),
      )
    : undefined;
  const pendingInputs = props.historyState ? getChatPendingInputs(props.historyState) : undefined;
  const displayedPendingInputs = pendingInputs
    ? [
        ...pendingInputs.page.items.filter(
          (input) => !input.queued && !isPendingInputDismissHidden(pendingInputs, input.id),
        ),
        ...pendingInputs.queuedInputs,
      ]
    : undefined;
  const resolveCommentSource = (selection: ChatSelectionSource) =>
    resolveChatCommentAnchor(props.transcript.messageElements?.elements.values() ?? [], selection)
      ?.range;
  const openSelectionComment = async (
    selection: ChatSelectionSource,
    anchorRect: DOMRect,
    stage: (attachment: ChatAttachment) => boolean,
    onCancel?: () => void,
    selectionContextOnly = false,
  ) => {
    const readSignal = props.readSignal;
    const sessionKey = props.sessionKey;
    const paneId = props.paneId;
    const sourceRange = resolveCommentSource(selection);
    const current = () =>
      !readSignal?.aborted && props.readSignal === readSignal && props.sessionKey === sessionKey;
    try {
      await showChatAnnotationEditor(
        {
          paneId,
          anchorRect,
          sourceRange,
          comment: "",
          readSignal,
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
        },
        current,
      );
    } catch (error) {
      if (current()) {
        showToast({ message: formatUiError(error) });
      }
    }
  };
  const canCompose = props.canSend;
  const historyState = props.historyState;
  const dismissPendingInputs =
    props.connected && props.canDismissPendingInputs && historyState
      ? (inputIds: readonly string[]) => void dismissChatPendingInputs(historyState, inputIds)
      : undefined;
  const questionState = getTranscriptState(props.paneId);
  const openImage = props.onOpenImage
    ? (item: ImageLightboxItem, requestVersion?: number) =>
        requestVersion === undefined
          ? props.onOpenImage?.(item)
          : props.onOpenImage?.(item, requestVersion)
    : undefined;
  const openImmediateImage = props.onOpenImage
    ? (item: ImageLightboxItem) => openImage?.(item, props.onRequestOpenImage?.())
    : undefined;
  const attachmentDropHandlers = createChatAttachmentDropHandlers(merge(props, { canCompose }));
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
  // Stream text changes whether a label is needed, not the label on every delta.
  const startupLabel = createMemo(() =>
    chatStartupStatusLabel(
      props.startupStatus,
      placementStartup,
      props.environmentStartStatus,
      (runWorking || props.stream !== null) &&
        props.awaitingActivity !== false &&
        !props.stream?.trim() &&
        props.toolMessages.length === 0,
    ),
  );
  const threadProps: ChatThreadProps = merge(props, {
    asyncQuestions,
    loading: props.loading && !placementStartup,
    streamStartedAt: placementStartup?.startedAt ?? props.streamStartedAt,
    queue,
    initialTurnId: props.placementStartup?.initialTurn?.id,
    pendingInputs: displayedPendingInputs,
    runActive: props.runActive === true,
    runWorking,
    runFinalizing: !isSessionRunVisuallyActive(true, props.startupStatus?.phase),
    get startupLabel() {
      return startupLabel();
    },
    retryAt: props.startupStatus?.phase === "retrying" ? props.startupStatus.retryAt : undefined,
    failureActionsRunId: chatFailureRunId(props.runError, props.selectedSession),
    questionPrompts: props.gatewayQuestionPrompts,
    agents: props.agentsList?.agents,
    onOpenImage: openImage,
    queuedMessageAction: props.placementStartup?.initialTurn
      ? {
          id: props.placementStartup.initialTurn.id,
          onAction: props.connected ? props.onRetrySessionPlacementStartup : undefined,
          onDiscard: props.onDiscardSessionPlacementStartup,
        }
      : undefined,
    onRetryQueuedMessage: props.connected && canCompose ? props.onQueueRetry : undefined,
    onDiscardQueuedMessage: props.onQueueRemove,
    onDismissPendingInput: dismissPendingInputs
      ? (inputId: string) => dismissPendingInputs([inputId])
      : undefined,
    onCompanionSelection:
      props.canSend && !props.suggestionComposer && props.onCompanionStageAttachment
        ? (selection, anchorRect) =>
            void openSelectionComment(
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
            void openSelectionComment(
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
                focusComposer();
                return true;
              },
              focusComposer,
            )
        : undefined,
    onOpenSession: props.onSessionSelect,
    // Portaled menus can outlive a render; resolve focus from the current session owner.
    onFocusComposer: () => focusComposer(true),
  } satisfies Partial<ChatThreadProps>);
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
  const transcriptEmpty = () =>
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
    dismissPendingInputs,
    asyncQuestions,
    openImmediateImage,
    attachmentDropHandlers,
    resolveCommentSource,
    threadProps,
    displayQueue,
    historyLoadState,
    historyFailed,
    get transcriptEmpty() {
      return transcriptEmpty();
    },
  };
}

export type ChatViewFrame = ReturnType<typeof createChatViewFrame>;
