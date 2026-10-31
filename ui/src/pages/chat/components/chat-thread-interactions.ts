import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { BrowserTabSelection } from "../../../components/browser/browser-target.ts";
import { copyMarkdownLabel, handleCopyButton } from "../../../components/copy-button-state.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type {
  ChatAttachment,
  ChatGuardianNotice,
  ChatQueueItem,
  ChatSelectionSource,
  ChatStreamSegment,
} from "../../../lib/chat/chat-types.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { listen } from "../../../lib/reactive/listener.ts";
// Pane-local search, context menus, selection actions, and presentation resets.
import type { TurnRecapWatch } from "../chat-progress.ts";
import type { SubagentRoster } from "../chat-spawned-subagent.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import type { ChatTranscriptMetadata } from "../chat-transcript-metadata.ts";
import type { ChatTypingActorView, ChatTypingOverflow } from "../chat-typing-presence.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation-state.ts";
import type { CompactionStatus, RunOutputUsage } from "../tool-stream-contract.ts";
import type { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import type { ChatCommentPinsHandle } from "./chat-comment-pins.tsx";
import { resolveChatContextCopy, usesNativeContextMenu } from "./chat-context-copy.ts";
import type { ChatHistoryBoundaryProps } from "./chat-history-boundary.tsx";
import { getMessageActionElements } from "./chat-message-action-elements.ts";
import type { MessageRenderOptions } from "./chat-message-bubble-options.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  openChatRewindConfirmation,
} from "./chat-message-confirmation-view.tsx";
import type { MessageActionDetails, MessageReplyTarget } from "./chat-message-markdown.types.ts";
import type { ChatSendStatusActions } from "./chat-message-send-status-view.tsx";
import type { ReplyMessageStatus } from "./chat-reply-preview.ts";
import {
  handleChatSelectionPointerUp,
  isChatSelectionPopupFocused,
  removeChatSelectionPopup,
} from "./chat-selection-popup.tsx";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { mountThreadMenu, type ThreadMenuAction } from "./chat-thread-menu.tsx";
import { TranscriptSearchState } from "./chat-transcript-search-state.ts";
import type { ChatWelcomeIdentityProps } from "./chat-welcome.tsx";

registerChatMessageMetadataEnglish();

export type ChatThreadState = Parameters<typeof createAsyncQuestionPresentation>[0] & {
  threadElement?: HTMLElement;
  commentPins?: ChatCommentPinsHandle;
  turnRecapWatch: TurnRecapWatch | null;
  search: TranscriptSearchState;
  transcriptRenderDependencies: readonly unknown[];
  transcriptRenderContext: {
    turnVideoMessages?: ReadonlyMap<
      string,
      readonly import("./chat-turn-video-gallery.ts").TurnVideoMessage[]
    >;
    onSetReply?: (target: MessageReplyTarget) => void;
    onOpenReply?: (replyToId: string) => void;
    onAsyncQuestionDiscard?: (item: ChatQueueItem) => void;
  };
};

type ReplyMessageAccess = {
  revision: number;
  navigationId: string | null;
  read: (messageId: string) => unknown;
  /** How the Gateway answered a lookup without a message. */
  status?: (messageId: string) => ReplyMessageStatus | undefined;
  open: (messageId: string) => void;
};

export type ChatThreadProps = Omit<
  MessageRenderOptions,
  | "onOpenReply"
  | "replyNavigationId"
  | "sessionKey"
  | "presented"
  | "agentId"
  | "mediaPolicyKey"
  | "getTurnVideoMessages"
  | "onOpenWorkspaceFile"
> &
  Pick<
    ChatWelcomeIdentityProps,
    | "currentAgentId"
    | "agents"
    | "assistantName"
    | "assistantAvatar"
    | "assistantAvatarUrl"
    | "assistantAvatarSource"
    | "sessionHost"
  > &
  ChatSendStatusActions &
  SubagentRoster & {
    applicationContext?: ApplicationContext;
    onScrollPortRef?: (element: HTMLElement) => void | (() => void);
    messageReactions?: ReadonlyMap<string, MessageReactionSummary[]>;
    onReact?: (messageId: string, emoji: string, remove: boolean) => void;
    branding?: ThemeBranding;
    compactionStatus?: CompactionStatus | null;
    paneId: string;
    /** Routing for peer sender names in a shared session. */
    personActivity?: PersonActivityRouting;
    sessionKey: string;
    presented?: PresentationValue;
    /** Mounted transcript visibility, independent of which split pane owns input. */
    transcriptVisible?: PresentationValue;
    gatewayClient?: GatewayBrowserClient | null;
    selectedSession: GatewaySessionRow | undefined;
    modelCatalog?: ModelCatalogEntry[];
    transcriptMetadata?: ChatTranscriptMetadata;
    announceTranscript?: boolean;
    loading: boolean;
    routeLoadingSkeleton?: boolean;
    /** Older-history pagination: renders the auto-load sentinel plus the in-flow boundary row. */
    historyPagination?: ChatHistoryBoundaryProps;
    messages: unknown[];
    toolMessages: unknown[];
    latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection>;
    guardianNotices?: ChatGuardianNotice[];
    streamSegments: ChatStreamSegment[];
    reasoning?: import("../tool-stream-contract.ts").ChatReasoning | null;
    stream: string | null;
    streamStartedAt: number | null;
    /** Browser-local active run identity, retained across transient disconnects. */
    runId?: string | null;
    runUsageById?: ReadonlyMap<string, RunOutputUsage>;
    queue: ChatQueueItem[];
    initialTurnId?: string;
    pendingInputs?: ChatPendingInputsPage["items"];
    chatBubbleMode?: boolean;
    showThinking: boolean;
    showToolCalls: boolean;
    persistCommentary?: boolean;
    runWorking?: boolean;
    runFinalizing?: boolean;
    startupLabel?: string;
    retryAt?: number;
    onRetryRun?: (runId: string) => void;
    failureActionsRunId?: string;
    onDismissPendingInput?: (inputId: string) => void;
    waitingApproval?: boolean;
    questionPrompts?: readonly QuestionPrompt[];
    sessions: SessionsListResult | null;
    senderAgentAvatars?: ReadonlyMap<string, string | null>;
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    userId?: string | null;
    userName?: string | null;
    userAvatar?: string | null;
    channelAvatar?: import("../../../lib/chat/channel-sender-avatar.ts").ChannelSenderAvatarSource;
    basePath?: string;
    sessionPublicOrigin?: string;
    fullMessageAgentId?: string;
    loadFullAssistantMessage?: SidebarFullMessageLoader | null;
    mediaPolicyEpoch?: number;
    autoExpandToolCalls?: boolean;
    /** Live captions update their retained row independently of the pane frame. */
    readRealtimeTalkConversation?: () => readonly RealtimeTalkConversationEntry[];
    typingActors?: readonly ChatTypingActorView[];
    typingOverflow?: ChatTypingOverflow;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: MarkdownFileLinkTarget) => void;
    onOpenManagedArtifact?: (href: string) => boolean;
    onOpenSessionLink?: (target: SessionLinkTarget) => void;
    onNavigate?: (routeId: "cron", options: { search: string }) => void;
    onChatScroll?: (event: Event) => void;
    onHistoryIntent?: (event: Event) => void;
    onHistorySentinelRef?: (element: HTMLElement) => void | (() => void);
    onTranscriptAnnouncementRef?: (element: HTMLElement) => void | (() => void);
    onSetReply?: (target: MessageReplyTarget) => void;
    replyMessageAccess?: ReplyMessageAccess;
    onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
    onForkMessage?: (entryId: string) => Promise<void> | void;
    onFocusComposer?: () => void;
    commentAttachments?: readonly ChatAttachment[];
    commentsDisabled?: boolean;
    onAddToChat?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    onCompanionSelection?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    /** Shows one of the session's subagents. */
    onOpenSubagent?: (sessionKey: string) => void;
    /** Shows the session's subagents; absent where the pane has no list of them to show. */
    onOpenSubagents?: (focus?: boolean) => void;
  };

type TranscriptInteractionProps = Pick<
  ChatThreadProps,
  | "paneId"
  | "runActive"
  | "runWorking"
  | "onSetReply"
  | "onRewindMessage"
  | "onForkMessage"
  | "onFocusComposer"
  | "onAddToChat"
  | "onCompanionSelection"
>;

const transcriptStates = new Map<string, ChatThreadState>();

export function getTranscriptState(paneId: string): ChatThreadState {
  const existing = transcriptStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state: ChatThreadState = {
    asyncQuestionDrafts: new Map(),
    asyncQuestionRevision: 0,
    turnRecapWatch: null,
    search: new TranscriptSearchState(),
    transcriptRenderDependencies: [],
    transcriptRenderContext: {},
  };
  transcriptStates.set(paneId, state);
  return state;
}

export function registerTranscriptElement(paneId: string, element: HTMLElement): () => void {
  const state = getTranscriptState(paneId);
  state.threadElement = element;
  return () => {
    if (state.threadElement === element) {
      state.threadElement = undefined;
    }
  };
}

export function isThreadPresentationFocused(paneId: string, owner: HTMLElement): boolean {
  const menu = activeReplyContextMenu?.paneId === paneId ? activeReplyContextMenu.element : null;
  return (
    owner.contains(owner.ownerDocument.activeElement) ||
    isChatSelectionPopupFocused(paneId) ||
    isConfirmedActionPopoverFocused(owner) ||
    Boolean(
      menu && (menu.contains(document.activeElement) || isConfirmedActionPopoverFocused(menu)),
    )
  );
}

export function dismissThreadPortals(paneId?: string, owner?: ParentNode): void {
  removeReplyContextMenu(paneId);
  if (owner) {
    dismissConfirmedActionPopovers(owner);
  }
  // The selection popup is body-portaled; pane teardown/route changes must
  // drop it so it cannot outlive the render that owns its callbacks.
  removeChatSelectionPopup(paneId);
}

export function resetTranscriptSession(paneId: string, owner?: ParentNode): void {
  dismissThreadPortals(paneId, owner);
  // Retained panes keep their DOM, so their native table modals need explicit retirement.
  const state = transcriptStates.get(paneId);
  if (state?.threadElement) {
    releaseMarkdownTables(state.threadElement);
  }
  if (state) {
    state.asyncQuestionDrafts = new Map();
    // Search input belongs to the outgoing transcript; pane preferences survive.
    state.search.reset();
  }
}

export function resetThreadPresentation(paneId?: string, owner?: ParentNode) {
  dismissThreadPortals(paneId, owner);
  const retiring = paneId ? [transcriptStates.get(paneId)] : transcriptStates.values();
  for (const state of retiring) {
    if (state) {
      // Retire captured card callbacks before removing the pane lookup. Already
      // captured writes may finish, but late send completions cannot invent new edits.
      state.asyncQuestionGeneration = (state.asyncQuestionGeneration ?? 0) + 1;
      state.asyncQuestionDrafts = new Map();
    }
  }
  if (paneId) {
    transcriptStates.delete(paneId);
  } else {
    transcriptStates.clear();
  }
  resetChatThreadState(paneId);
}

/** Toggles transcript search and retains the shortcut origin for focus restoration. */
export function toggleTranscriptSearch(
  paneId: string,
  triggerEvent?: Event,
  restoreFocus?: () => void,
): void {
  getTranscriptState(paneId).search.toggle(triggerEvent, restoreFocus);
}

let activeReplyContextMenu: {
  element: HTMLElement;
  paneId: string;
  listeners: AbortController;
  dispose: () => void;
} | null = null;

function removeReplyContextMenu(paneId?: string) {
  const owner = activeReplyContextMenu;
  if (paneId && paneId !== owner?.paneId) {
    return;
  }
  activeReplyContextMenu = null;
  if (owner) {
    dismissConfirmedActionPopovers(owner.element);
    owner.listeners.abort();
    owner.dispose();
  }
}

const revealedMessages = new WeakMap<HTMLElement, { group: HTMLElement; bubble: Element | null }>();

function toggleTouchMessageMeta(event: PointerEvent, messageElements: Iterable<HTMLElement>): void {
  const transcript = event.currentTarget;
  const target = event.target;
  if (
    event.pointerType !== "touch" ||
    !(transcript instanceof HTMLElement) ||
    !(target instanceof Element)
  ) {
    return;
  }
  const group = target.closest(".chat-group--with-footer");
  if (
    !(group instanceof HTMLElement) ||
    !transcript.contains(group) ||
    target.closest("a, button, details, input, label, select, textarea, [contenteditable]")
  ) {
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    return;
  }
  // Resolve the message before clearing disclosure so a tap on a sibling moves
  // the actions, while tapping the same message still toggles them off.
  const bubble = group.classList.contains("chat-group--peer")
    ? (target.closest(".chat-bubble") ??
      // Tapping beside an image must reveal its actions without opening the image.
      [...messageElements].find((candidate) => {
        if (!group.contains(candidate)) {
          return false;
        }
        const bounds = candidate.getBoundingClientRect();
        return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      }) ??
      null)
    : null;
  const reveal = bubble
    ? !bubble.classList.contains("chat-bubble--actions-revealed")
    : !group.classList.contains("chat-group--meta-revealed");
  const previous = revealedMessages.get(transcript);
  previous?.group.classList.remove("chat-group--meta-revealed");
  previous?.bubble?.classList.remove("chat-bubble--actions-revealed");
  group.classList.toggle("chat-group--meta-revealed", reveal);
  bubble?.classList.toggle("chat-bubble--actions-revealed", reveal);
  if (reveal) {
    revealedMessages.set(transcript, { group, bubble });
  } else {
    revealedMessages.delete(transcript);
  }
}

export function handleTranscriptSelectionMouseDown(event: MouseEvent) {
  const thread = event.currentTarget;
  const target = event.target;
  if (
    event.button !== 0 ||
    event.detail < 2 ||
    !(thread instanceof HTMLElement) ||
    !(target instanceof Element) ||
    target.closest("a, button, input, select, textarea, summary, [contenteditable]")
  ) {
    return undefined;
  }
  const bubble = target.closest(".chat-bubble");
  const view = thread.ownerDocument.defaultView;
  if (!bubble || !thread.contains(bubble) || !view) {
    return undefined;
  }
  // Capture the pressed message before mouseup/dblclick can target a common
  // ancestor, including when the drag is released outside this transcript.
  const listeners = new AbortController();
  const stop = () => listeners.abort();
  listen(
    view,
    "mouseup",
    () => {
      stop();
      if (thread.isConnected && thread.contains(bubble)) {
        boundMessageSelection(bubble);
      }
    },
    { once: true, signal: listeners.signal },
  );
  listen(view, "blur", stop, { once: true, signal: listeners.signal });
  return stop;
}

function boundMessageSelection(bubble: Element) {
  const selection = bubble.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (
    !range.intersectsNode(bubble) ||
    (bubble.contains(range.startContainer) && bubble.contains(range.endContainer))
  ) {
    return;
  }
  // Intersect only this multi-click gesture; ordinary drags and Select All stay native.
  const backwards =
    selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
  const bounded = range.cloneRange();
  const contents = bubble.ownerDocument.createRange();
  contents.selectNodeContents(bubble);
  if (bounded.compareBoundaryPoints(Range.START_TO_START, contents) < 0) {
    bounded.setStart(contents.startContainer, contents.startOffset);
  }
  if (bounded.compareBoundaryPoints(Range.END_TO_END, contents) > 0) {
    bounded.setEnd(contents.endContainer, contents.endOffset);
  }
  selection.setBaseAndExtent(
    backwards ? bounded.endContainer : bounded.startContainer,
    backwards ? bounded.endOffset : bounded.startOffset,
    backwards ? bounded.startContainer : bounded.endContainer,
    backwards ? bounded.startOffset : bounded.endOffset,
  );
}

export function handleTranscriptPointerUp(
  event: PointerEvent,
  props: TranscriptInteractionProps,
  messageElements: Iterable<HTMLElement> = [],
) {
  toggleTouchMessageMeta(event, messageElements);
  if (event.button !== 0 || event.ctrlKey || typeof props.onCompanionSelection !== "function") {
    return;
  }
  handleChatSelectionPointerUp(event, {
    paneId: props.paneId,
    onAddToChat: props.onAddToChat,
    onAskSideChat: (selection, anchorRect) => props.onCompanionSelection?.(selection, anchorRect),
  });
}

function selectionIntersectsElement(selection: Selection | null, element: Element): boolean {
  if (!selection || selection.isCollapsed) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) {
      return true;
    }
  }
  return false;
}

export function handleTranscriptContextMenu(
  event: MouseEvent,
  props: TranscriptInteractionProps,
  messageElements: Iterable<HTMLElement> = [],
) {
  if (event.defaultPrevented || usesNativeContextMenu(event.composedPath())) {
    return;
  }
  const target = event.composedPath().find((item): item is Element => item instanceof Element);
  if (!target) {
    return;
  }
  const bubble = target.closest<HTMLElement & { messageActions?: MessageActionDetails | null }>(
    ".chat-bubble",
  );
  const group = bubble?.closest<HTMLElement>(".chat-group");
  if (
    group?.dataset.chatStreaming === "true" ||
    bubble?.classList.contains("streaming") ||
    (group &&
      [...messageElements].some(
        (element) => group.contains(element) && element.classList.contains("streaming"),
      ))
  ) {
    return;
  }
  const contentCopy = resolveChatContextCopy(target);
  const selection = window.getSelection();
  const selectedText = selectionIntersectsElement(selection, bubble ?? target)
    ? selection?.toString()
    : "";
  // The menu and footer consume the same target, including attachment-only replies.
  const replyTarget = bubble?.messageActions?.replyTarget;
  const entryId = bubble?.dataset.entryId?.trim() ?? "";
  const messageId = bubble?.dataset.messageId?.trim() ?? "";
  const isUserMessage = group?.classList.contains("user") && Boolean(entryId);
  // Grouped rows can contain several bubbles. Match the clicked bubble to its
  // own action owner so copy never targets a sibling message.
  const actionOwner = group && getMessageActionElements(group, messageId);
  const copyButton = actionOwner?.copy;
  const readAloudButton = actionOwner?.readAloud;
  const ownsRunFrame = group?.dataset.chatRowKey?.startsWith("agent-run:") === true;
  const canReply = Boolean(replyTarget && props.onSetReply && (!ownsRunFrame || actionOwner));
  const canRewind = isUserMessage && typeof props.onRewindMessage === "function";
  const copyMarkdown = bubble?.messageActions?.copyMarkdown;
  const canCopy = Boolean(copyButton || copyMarkdown);
  const canFork = isUserMessage && typeof props.onForkMessage === "function";
  if (!canReply && !canRewind && !canCopy && !canFork && !selectedText && !contentCopy?.text) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  removeReplyContextMenu();
  const actions: ThreadMenuAction[] = [];
  const appendCopyAction = (label: string, text: string) => {
    if (!text) {
      return;
    }
    actions.push({
      label,
      tooltip: label,
      onClick: (copyEvent, labelElement) => {
        void handleCopyButton(copyEvent, text, label, { label: labelElement }).then((copied) => {
          if (copied && activeReplyContextMenu?.element === menu) {
            removeReplyContextMenu(props.paneId);
          }
        });
      },
    });
  };
  if (selectedText) {
    appendCopyAction(t("chat.messages.copySelection"), selectedText);
  }
  if (contentCopy) {
    appendCopyAction(contentCopy.label, contentCopy.text);
  }
  if (canReply && replyTarget) {
    actions.push({
      label: t("chat.messages.reply"),
      ariaLabel: t("chat.messages.replyToMessage"),
      onClick: () => {
        props.onSetReply?.(replyTarget);
        removeReplyContextMenu();
        props.onFocusComposer?.();
      },
    });
  }
  const working = Boolean(props.runActive || props.runWorking);
  if (canRewind) {
    actions.push({
      label: t("chat.messages.rewindToHere"),
      disabled: working,
      tooltip: working ? t("chat.messages.rewindUnavailable") : t("chat.messages.rewindToHere"),
      className: "chat-confirm-wrap chat-rewind-wrap",
      onClick: (rewindEvent) => {
        // SAFETY: Menu actions bind directly to their native button.
        openChatRewindConfirmation(rewindEvent.currentTarget as HTMLButtonElement, () => {
          removeReplyContextMenu();
          void Promise.resolve(props.onRewindMessage?.(entryId)).then((rewound) => {
            if (rewound) {
              props.onFocusComposer?.();
            }
          });
        });
      },
    });
  }
  if (copyMarkdown && !copyButton) {
    appendCopyAction(copyMarkdownLabel(), copyMarkdown);
  } else if (copyButton) {
    actions.push({
      label: copyMarkdownLabel(),
      tooltip: copyMarkdownLabel(),
      onClick: () => {
        removeReplyContextMenu();
        copyButton?.click();
      },
    });
  }
  if (readAloudButton) {
    const label = readAloudButton.getAttribute("aria-label") ?? t("chat.messages.readAloud");
    actions.push({
      label,
      tooltip: label,
      onClick: () => {
        removeReplyContextMenu();
        readAloudButton.click();
      },
    });
  }
  if (canFork) {
    actions.push({
      label: t("chat.messages.forkFromHere"),
      disabled: working,
      tooltip: working ? t("chat.messages.forkUnavailable") : t("chat.messages.forkFromHere"),
      onClick: () => {
        removeReplyContextMenu();
        void props.onForkMessage?.(entryId);
      },
    });
  }
  // Expanded tables live in a native modal. Its context menu must stay inside
  // that top layer, otherwise the browser makes the body portal inert.
  const mounted = mountThreadMenu(
    actions,
    target.closest("openclaw-modal-dialog, dialog") ?? document.body,
    event.clientX,
    event.clientY,
  );
  const menu = mounted.element;
  const { dispose } = mounted;
  const owner = { element: menu, paneId: props.paneId, listeners: new AbortController(), dispose };
  activeReplyContextMenu = owner;

  const menuRect = menu.getBoundingClientRect();
  let left = event.clientX;
  let top = event.clientY;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 8;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height - 8;
  }
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  mounted.firstButton?.focus();
  requestAnimationFrame(() => {
    if (!menu.isConnected || activeReplyContextMenu !== owner) {
      return;
    }
    const handleOutsideEvent = (nextEvent: MouseEvent) => {
      if (!menu.contains(nextEvent.target as Node | null)) {
        removeReplyContextMenu();
      }
    };
    const handleKeydown = (nextEvent: KeyboardEvent) => {
      if (nextEvent.key === "Escape") {
        nextEvent.preventDefault();
        nextEvent.stopPropagation();
        removeReplyContextMenu();
        props.onFocusComposer?.();
      }
    };
    const { signal } = owner.listeners;
    listen(document, "click", handleOutsideEvent, { signal });
    // Capture closes this owner even when the next menu stops event propagation.
    listen(document, "contextmenu", handleOutsideEvent, { capture: true, signal });
    listen(document, "keydown", handleKeydown, { signal });
  });
}
