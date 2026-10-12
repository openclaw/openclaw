// Pane-local search, context menus, selection actions, and presentation resets.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../../api/types.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { BrowserTabSelection } from "../../../components/browser/browser-target.ts";
import { copyMarkdownLabel, handleCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import "../../../components/tooltip.ts";
import type {
  ChatAttachment,
  ChatGuardianNotice,
  ChatQueueItem,
  ChatSelectionSource,
  ChatStreamSegment,
} from "../../../lib/chat/chat-types.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import type { PresentationValue } from "../../../lit/presentation-binding.ts";
import type { TurnRecapWatch } from "../chat-progress.ts";
import type { SubagentRoster } from "../chat-spawned-subagent.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ChatTypingActorView, ChatTypingOverflow } from "../chat-typing-presence.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import type { ChatTranscriptMetadata } from "../session-message-cache.ts";
import type { RealtimeTalkConversationEntry } from "../talk/conversation.ts";
import type { CompactionStatus, RunOutputUsage } from "../tool-stream-contract.ts";
import type { AsyncQuestionDraft, AsyncQuestionPresentation } from "./chat-async-question.types.ts";
import { resolveChatContextCopy, usesNativeContextMenu } from "./chat-context-copy.ts";
import type { ChatHistoryBoundaryProps } from "./chat-history-boundary.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  openChatRewindConfirmation,
} from "./chat-message-confirmation.ts";
import type { MessageActionDetails, MessageReplyTarget } from "./chat-message-markdown.types.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import type { ChatSendStatusActions } from "./chat-message-send-status.ts";
import type { ReplyMessageStatus } from "./chat-reply-preview.ts";
import {
  handleChatSelectionPointerUp,
  isChatSelectionPopupFocused,
  removeChatSelectionPopup,
} from "./chat-selection-popup.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";

registerChatMessageMetadataEnglish();

export type ChatThreadState = {
  asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
  asyncQuestionSessions?: Map<
    string,
    import("./chat-async-question-draft.ts").AsyncQuestionDraftSession
  >;
  asyncQuestionRevision: number;
  asyncQuestionScope?: string;
  asyncQuestionGeneration?: number;
  asyncQuestionPresentation?: AsyncQuestionPresentation;
  turnRecapWatch: TurnRecapWatch | null;
  searchOpen: boolean;
  searchQuery: string;
  searchFocusPending: boolean;
  searchReturnFocusTarget: HTMLElement | null;
  searchReturnFocusOwner: HTMLElement | null;
  transcriptRenderDependencies: readonly unknown[];
  transcriptRenderContext: {
    onRequestUpdate?: () => void;
    turnVideoMessages?: ReadonlyMap<
      string,
      readonly import("./chat-turn-video-gallery.ts").TurnVideoMessage[]
    >;
    onSetReply?: (target: MessageReplyTarget) => void;
    onOpenReply?: (replyToId: string) => void;
    onAsyncQuestionDiscard?: (item: ChatQueueItem) => void;
    onAsyncQuestionSubmit?: (
      message: string,
      itemId?: string,
      sourceMessageId?: string,
    ) => Promise<boolean>;
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

export type ChatThreadProps = ChatSendStatusActions &
  SubagentRoster & {
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
    transcriptMetadata?: ChatTranscriptMetadata;
    boardProvider?: BoardProvider;
    widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
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
    runActive?: boolean;
    runWorking?: boolean;
    startupLabel?: string;
    waitingApproval?: boolean;
    questionPrompts?: readonly QuestionPrompt[];
    asyncQuestions?: AsyncQuestionPresentation;
    sessions: SessionsListResult | null;
    /** Host context resolving global-alias session keys (scope=global fleets). */
    sessionHost?: UiSessionDefaultsHost | null;
    assistantName: string;
    assistantAvatar: string | null;
    senderAgentAvatars?: ReadonlyMap<string, string | null>;
    agents?: AgentsListResult["agents"];
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    currentAgentId?: string;
    assistantAvatarUrl?: string | null;
    userId?: string | null;
    userName?: string | null;
    userAvatar?: string | null;
    basePath?: string;
    sessionPublicOrigin?: string;
    resourceBasePath?: string;
    fullMessageAgentId?: string;
    loadFullAssistantMessage?: SidebarFullMessageLoader | null;
    mediaPolicyEpoch?: number;
    connectionEpoch?: number;
    assistantAttachmentAuthToken?: string | null;
    resolveArtifactDownload?: ArtifactDownloadResolver;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    fetchLinkFavicon?: LinkFaviconFetcher;
    pluginToolIcons?: PluginToolIcons;
    githubRepo?: MarkdownRenderOptions["githubRepo"];
    githubRepositories?: MarkdownRenderOptions["githubRepositories"];
    autoExpandToolCalls?: boolean;
    realtimeTalkConversation?: RealtimeTalkConversationEntry[];
    typingActors?: readonly ChatTypingActorView[];
    typingOverflow?: ChatTypingOverflow;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: MarkdownFileLinkTarget) => void;
    onOpenSessionLink?: (target: SessionLinkTarget) => void;
    onNavigate?: (routeId: "cron", options: { search: string }) => void;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    onAssistantAttachmentLoaded?: () => void;
    onRequestUpdate?: () => void;
    onChatScroll?: (event: Event) => void;
    onHistoryIntent?: (event: Event) => void;
    onDraftChange: (next: string) => void;
    onSend: () => void;
    onSetReply?: (target: MessageReplyTarget) => void;
    replyMessageAccess?: ReplyMessageAccess;
    onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
    onForkMessage?: (entryId: string) => Promise<void> | void;
    onFocusComposer?: () => void;
    commentAttachments?: readonly ChatAttachment[];
    commentsDisabled?: boolean;
    onAddToChat?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    onCompanionSelection?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
    onOpenSession?: (sessionKey: string) => void;
    /** Shows one of the session's subagents. */
    onOpenSubagent?: (sessionKey: string) => void;
    /** Shows the session's subagents; absent where the pane has no list of them to show. */
    onOpenSubagents?: () => void;
    modelSetupRequired?: boolean;
    onModelSetup?: () => void;
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
const transcriptSearchDefaults = {
  searchOpen: false,
  searchQuery: "",
  searchFocusPending: false,
  searchReturnFocusTarget: null,
  searchReturnFocusOwner: null,
};

export function getTranscriptState(paneId: string): ChatThreadState {
  const existing = transcriptStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state: ChatThreadState = {
    asyncQuestionDrafts: new Map(),
    asyncQuestionRevision: 0,
    turnRecapWatch: null,
    ...transcriptSearchDefaults,
    transcriptRenderDependencies: [],
    transcriptRenderContext: {},
  };
  transcriptStates.set(paneId, state);
  return state;
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
  owner?.querySelectorAll<HTMLElement>(".chat-thread").forEach(releaseMarkdownTables);
  const state = transcriptStates.get(paneId);
  if (state) {
    state.asyncQuestionDrafts = new Map();
    // Parked rows must commit fresh bindings on return even when visible props match.
    state.transcriptRenderDependencies = [];
    // Search input belongs to the outgoing transcript; pane preferences survive.
    Object.assign(state, transcriptSearchDefaults);
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

export function renderTranscriptSearch(
  paneId: string,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getTranscriptState(paneId);
  if (!state.searchOpen) {
    return nothing;
  }
  return html`
    <div
      class="agent-chat__search-bar"
      @keydown=${(event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.isComposing ||
          event.keyCode === 229
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeTranscriptSearch(state, requestUpdate);
      }}
    >
      ${icons.search}
      <input
        type="text"
        placeholder=${t("chat.thread.searchPlaceholder")}
        aria-label=${t("chat.thread.search")}
        .value=${state.searchQuery}
        ${
          state.searchFocusPending
            ? ref((element) => {
                if (element instanceof HTMLInputElement) {
                  state.searchFocusPending = false;
                  queueMicrotask(() => {
                    if (element.isConnected) {
                      element.focus({ preventScroll: true });
                    }
                  });
                }
              })
            : nothing
        }
        @input=${(event: Event) => {
          state.searchQuery = (event.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <openclaw-tooltip .content=${t("chat.thread.closeSearch")}>
        <button
          class="btn btn--ghost"
          aria-label=${t("chat.thread.closeSearch")}
          @click=${() => closeTranscriptSearch(state, requestUpdate)}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

export function closeTranscriptSearch(state: ChatThreadState, requestUpdate: () => void): void {
  const returnFocusTarget = state.searchReturnFocusTarget;
  const returnFocusOwner = state.searchReturnFocusOwner;
  Object.assign(state, transcriptSearchDefaults);
  requestUpdate();
  queueMicrotask(() => {
    const target = returnFocusTarget?.isConnected
      ? returnFocusTarget
      : returnFocusOwner?.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
    target?.focus({ preventScroll: true });
  });
}

/** Toggles transcript search and retains the shortcut origin for focus restoration. */
export function toggleTranscriptSearch(
  paneId: string,
  requestUpdate: () => void,
  triggerEvent?: Event,
): void {
  const state = getTranscriptState(paneId);
  if (state.searchOpen) {
    closeTranscriptSearch(state, requestUpdate);
    return;
  }

  state.searchOpen = true;
  state.searchFocusPending = true;
  const returnFocusTarget = triggerEvent?.target;
  const returnFocusOwner = triggerEvent?.currentTarget;
  const connectedElement = (target: EventTarget | null | undefined) =>
    target instanceof HTMLElement && target.isConnected ? target : null;
  state.searchReturnFocusTarget = connectedElement(returnFocusTarget);
  state.searchReturnFocusOwner = connectedElement(returnFocusOwner);
  requestUpdate();
}

let activeReplyContextMenu: {
  element: HTMLElement;
  paneId: string;
  listeners: AbortController;
} | null = null;

function removeReplyContextMenu(paneId?: string) {
  const owner = activeReplyContextMenu;
  if (paneId && paneId !== owner?.paneId) {
    return;
  }
  if (owner) {
    dismissConfirmedActionPopovers(owner.element);
    owner.element.remove();
  }
  activeReplyContextMenu = null;
  const fallbackMenu = document.querySelector<HTMLElement>(".chat-reply-context-menu");
  if (fallbackMenu) {
    dismissConfirmedActionPopovers(fallbackMenu);
    fallbackMenu.remove();
  }
  owner?.listeners.abort();
}

function toggleTouchMessageMeta(event: PointerEvent): void {
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
      [...group.querySelectorAll(".chat-bubble")].find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      }))
    : null;
  const reveal = bubble
    ? !bubble.classList.contains("chat-bubble--actions-revealed")
    : !group.classList.contains("chat-group--meta-revealed");
  for (const revealed of transcript.querySelectorAll(".chat-group--meta-revealed")) {
    revealed.classList.remove("chat-group--meta-revealed");
  }
  group.classList.toggle("chat-group--meta-revealed", reveal);
  for (const revealed of transcript.querySelectorAll(".chat-bubble--actions-revealed")) {
    revealed.classList.remove("chat-bubble--actions-revealed");
  }
  if (reveal) {
    bubble?.classList.add("chat-bubble--actions-revealed");
  }
}

export function handleTranscriptPointerUp(event: PointerEvent, props: TranscriptInteractionProps) {
  toggleTouchMessageMeta(event);
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

export function handleTranscriptContextMenu(event: MouseEvent, props: TranscriptInteractionProps) {
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
  if (group?.querySelector(".chat-reading-indicator, .chat-bubble.streaming")) {
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
  const actionOwner = [
    ...(group?.querySelectorAll<HTMLElement>("[data-message-actions-for]") ?? []),
  ].find((element) => element.dataset.messageActionsFor === messageId);
  const copyButton = actionOwner?.querySelector<HTMLButtonElement>(".chat-copy-btn");
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
  const menu = document.createElement("div");
  menu.className = "chat-reply-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("chat.messages.actions"));
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const focusCandidates: HTMLButtonElement[] = [];
  const appendAction = (params: {
    label: string;
    disabled?: boolean;
    tooltip: string;
    className?: string;
    onClick: (event: Event) => void;
  }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = params.disabled ?? false;
    button.setAttribute("role", "menuitem");
    button.addEventListener("click", params.onClick);
    const label = document.createElement("span");
    label.dataset.copyLabel = "";
    label.textContent = params.label;
    button.append(label);
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = params.tooltip;
    tooltip.append(button);
    if (params.className) {
      tooltip.className = params.className;
    }
    menu.append(tooltip);
    focusCandidates.push(button);
    return button;
  };
  const appendCopyAction = (label: string, text: string) => {
    if (!text) {
      return;
    }
    appendAction({
      label,
      tooltip: label,
      onClick: (copyEvent) => {
        void handleCopyButton(copyEvent, text, label).then((copied) => {
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
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", t("chat.messages.replyToMessage"));
    button.textContent = t("chat.messages.reply");
    button.addEventListener("click", () => {
      props.onSetReply?.(replyTarget);
      removeReplyContextMenu();
      props.onFocusComposer?.();
    });
    menu.append(button);
    focusCandidates.push(button);
  }
  const working = Boolean(props.runActive || props.runWorking);
  if (canRewind) {
    const button = appendAction({
      label: t("chat.messages.rewindToHere"),
      disabled: working,
      tooltip: working ? t("chat.messages.rewindUnavailable") : t("chat.messages.rewindToHere"),
      className: "chat-confirm-wrap chat-rewind-wrap",
      onClick: () => {
        openChatRewindConfirmation(button, () => {
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
    appendAction({
      label: copyMarkdownLabel(),
      tooltip: copyMarkdownLabel(),
      onClick: () => {
        removeReplyContextMenu();
        copyButton?.click();
      },
    });
  }
  if (canFork) {
    appendAction({
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
  (target.closest("openclaw-modal-dialog, dialog") ?? document.body).appendChild(menu);
  const owner = { element: menu, paneId: props.paneId, listeners: new AbortController() };
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
  focusCandidates.find((button) => !button.disabled)?.focus();
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
    document.addEventListener("click", handleOutsideEvent, { signal });
    // Capture closes this owner even when the next menu stops event propagation.
    document.addEventListener("contextmenu", handleOutsideEvent, { capture: true, signal });
    document.addEventListener("keydown", handleKeydown, { signal });
  });
}
