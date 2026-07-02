// Control UI view renders chat screen content.
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type { SessionGoal, SessionsListResult } from "../../api/types.ts";
import { icons, type IconName } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  CATEGORY_LABELS,
  SLASH_COMMANDS,
  getHiddenCommandCount,
  getSlashCommandCompletions,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { formatGoalDetail, formatGoalSummary } from "../../lib/session-goal.ts";
import { detectTextDirection } from "../../lib/text-direction.ts";
import type { CompactionStatus, FallbackStatus } from "../../ui/app-tool-stream.ts";
import {
  CHAT_ATTACHMENT_ACCEPT,
  clickComposerFileInput,
  handleChatAttachmentDrop,
  handleChatAttachmentFileSelect,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderChatQueue,
  renderChatRunControls,
  renderChatRunStatusIndicator,
  renderCompactionIndicator,
  renderContextNotice,
  renderFallbackIndicator,
} from "./components/chat-composer-controls.ts";
import {
  renderRealtimeTalkOptions,
  type RealtimeTalkOptions,
} from "./components/chat-realtime-controls.ts";
import type {
  DetailFullMessageResult,
  SidebarContent,
  SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import "./components/chat-sidebar.ts";
import {
  isChatThreadSearchOpen,
  renderChatPinnedMessages,
  renderChatSearchBar,
  renderChatThread,
  resetChatThreadPresentationState,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import { exportChatMarkdown } from "./export.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RealtimeTalkCatalogProvider } from "./realtime-talk-catalog.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import { renderSessionWorkspaceRail, type SessionWorkspaceProps } from "./session-workspace.ts";
import { renderSideResult, type ChatSideResult } from "./side-result.ts";
import "../../components/resizable-divider.ts";

const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "sending" || item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  sideResult?: ChatSideResult | null;
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkTranscript?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkOptionsOpen?: boolean;
  realtimeTalkCatalogProviders?: RealtimeTalkCatalogProvider[] | null;
  realtimeTalkOptions?: RealtimeTalkOptions;
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  focusMode?: boolean;
  onLoadSidebarFullMessage?: (
    request: SidebarFullMessageRequest,
  ) => Promise<DetailFullMessageResult | null | undefined>;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  splitRatio?: number;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string | null;
  assistantName: string;
  assistantAvatar: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onAssistantAttachmentLoaded?: () => void;
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  onRefresh: () => void;
  onToggleFocusMode?: () => void;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeTalkOptions?: () => void;
  onRealtimeTalkOptionsChange?: (
    next: Partial<NonNullable<ChatProps["realtimeTalkOptions"]>>,
  ) => void;
  onDismissError?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onDismissSideResult?: () => void;
  onNewSession: () => void;
  onClearHistory?: () => void;
  agentsList: {
    agents: Array<{ id: string; name?: string; identity?: { name?: string; avatarUrl?: string } }>;
    defaultId?: string;
  } | null;
  currentAgentId: string;
  fullMessageAgentId?: string;
  onAgentChange: (agentId: string) => void;
  onNavigateToAgent?: () => void;
  onSessionSelect?: (sessionKey: string) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  basePath?: string;
  composerControls?: TemplateResult | typeof nothing | ReturnType<typeof guard>;
  /** Selected message to reply to (set via right-click or keyboard shortcut). */
  replyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
  /** Clear the current reply target. */
  onClearReply?: () => void;
  /** Set the reply target from a message element. */
  onSetReply?: (target: { messageId: string; text: string; senderLabel?: string | null }) => void;
  sessionWorkspace?: SessionWorkspaceProps;
};

const SLASH_MENU_LISTBOX_ID = "chat-slash-menu-listbox";
const SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID = "chat-slash-active-announcement";

type PendingClearedSubmittedDraft = {
  key: string;
  value: string;
};

interface ChatEphemeralState {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuExpanded: boolean;
  slashCommandRefreshPending: boolean;
  composerComposing: boolean;
  composerInputIntentKey: string | null;
  pendingClearedSubmittedDraft: PendingClearedSubmittedDraft | null;
}

function createChatEphemeralState(): ChatEphemeralState {
  return {
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuExpanded: false,
    slashCommandRefreshPending: false,
    composerComposing: false,
    composerInputIntentKey: null,
    pendingClearedSubmittedDraft: null,
  };
}

const vs = createChatEphemeralState();

function composerDraftKey(props: Pick<ChatProps, "currentAgentId" | "sessionKey">): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

function commitComposerDraft(props: ChatProps, value: string): void {
  if (props.getDraft?.() === value || props.draft === value) {
    return;
  }
  props.onDraftChange(value);
}

function markComposerInputIntent(key: string): void {
  vs.composerInputIntentKey = key;
}

function consumeComposerInputIntent(key: string): boolean {
  if (vs.composerInputIntentKey !== key) {
    return false;
  }
  vs.composerInputIntentKey = null;
  return true;
}

function clearPendingClearedSubmittedDraft(key: string): void {
  if (vs.pendingClearedSubmittedDraft?.key === key) {
    vs.pendingClearedSubmittedDraft = null;
  }
}

function isExplicitComposerInsertion(event: InputEvent): boolean {
  return event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
}

function suppressStaleSubmittedDraftReplay(
  target: HTMLTextAreaElement,
  event: InputEvent,
  currentDraft: string,
  hasInputIntent: boolean,
): boolean {
  const pending = vs.pendingClearedSubmittedDraft;
  if (!pending) {
    return false;
  }
  if (target.value !== pending.value || hasInputIntent || isExplicitComposerInsertion(event)) {
    return false;
  }

  target.value = currentDraft;
  adjustTextareaHeight(target);
  return true;
}

/**
 * Reset chat view ephemeral state when navigating away.
 * Clears search/slash UI that should not survive navigation.
 */
export function resetChatViewState() {
  Object.assign(vs, createChatEphemeralState());
  resetChatThreadPresentationState();
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

function focusComposerFromChrome(event: MouseEvent, connected: boolean) {
  if (!connected || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const currentTarget = event.currentTarget;
  if (!(target instanceof Element) || !(currentTarget instanceof HTMLElement)) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}

function renderChatGoal(goal: SessionGoal | undefined): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  return html`
    <openclaw-tooltip .content=${formatGoalDetail(goal)}>
      <div
        class="agent-chat__goal agent-chat__goal--${goal.status}"
        role="status"
        aria-label=${formatGoalDetail(goal)}
      >
        <span class="agent-chat__goal-label">${formatGoalSummary(goal)}</span>
        <span class="agent-chat__goal-objective">${goal.objective}</span>
      </div>
    </openclaw-tooltip>
  `;
}

function resetSlashMenuState(): void {
  vs.slashMenuMode = "command";
  vs.slashMenuCommand = null;
  vs.slashMenuArgItems = [];
  vs.slashMenuItems = [];
  vs.slashMenuExpanded = false;
}

function hasVisibleSlashMenuState(): boolean {
  return (
    vs.slashMenuOpen ||
    vs.slashMenuMode !== "command" ||
    vs.slashMenuCommand !== null ||
    vs.slashMenuArgItems.length > 0 ||
    vs.slashMenuItems.length > 0 ||
    vs.slashMenuExpanded
  );
}

function closeSlashMenuIfNeeded(requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState()) {
    return;
  }
  vs.slashMenuOpen = false;
  resetSlashMenuState();
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  if (!props.onSlashIntent || vs.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  vs.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    vs.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  // Arg mode: /command <partial-arg>
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1].toLowerCase();
    const argFilter = argMatch[2].toLowerCase();
    const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((opt) => opt.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        vs.slashMenuMode = "args";
        vs.slashMenuCommand = cmd;
        vs.slashMenuArgItems = filtered;
        vs.slashMenuOpen = true;
        vs.slashMenuIndex = 0;
        vs.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }

  // Command mode: /partial-command
  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1], { showAll: vs.slashMenuExpanded });
    vs.slashMenuItems = items;
    vs.slashMenuOpen = items.length > 0;
    vs.slashMenuIndex = 0;
    vs.slashMenuMode = "command";
    vs.slashMenuCommand = null;
    vs.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }
  requestUpdate();
}

function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatProps,
  requestUpdate: () => void,
): void {
  // Transition to arg picker when the command has fixed options
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    vs.slashMenuMode = "args";
    vs.slashMenuCommand = cmd;
    vs.slashMenuArgItems = cmd.argOptions;
    vs.slashMenuOpen = true;
    vs.slashMenuIndex = 0;
    vs.slashMenuItems = [];
    requestUpdate();
    return;
  }

  vs.slashMenuOpen = false;
  resetSlashMenuState();

  if (cmd.executeLocal && !cmd.args) {
    commitComposerDraft(props, `/${cmd.name}`);
    requestUpdate();
    if (props.connected && props.canSend) {
      props.onSend();
    }
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    requestUpdate();
  }
}

function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatProps,
  requestUpdate: () => void,
): void {
  // Tab: fill in the command text without executing
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    vs.slashMenuMode = "args";
    vs.slashMenuCommand = cmd;
    vs.slashMenuArgItems = cmd.argOptions;
    vs.slashMenuOpen = true;
    vs.slashMenuIndex = 0;
    vs.slashMenuItems = [];
    requestUpdate();
    return;
  }

  vs.slashMenuOpen = false;
  resetSlashMenuState();
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  requestUpdate();
}

function selectSlashArg(
  arg: string,
  props: ChatProps,
  requestUpdate: () => void,
  execute: boolean,
): void {
  const cmdName = vs.slashMenuCommand?.name ?? "";
  vs.slashMenuOpen = false;
  resetSlashMenuState();
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  requestUpdate();
  if (execute && props.connected && props.canSend) {
    props.onSend();
  }
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

function getSlashCommandOptionId(cmd: SlashCommandDef): string {
  return `chat-slash-option-command-${slashOptionIdSegment(cmd.name)}`;
}

function getSlashArgOptionId(commandName: string, arg: string): string {
  return `chat-slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`;
}

function isSlashMenuVisible(): boolean {
  if (!vs.slashMenuOpen) {
    return false;
  }
  if (vs.slashMenuMode === "args") {
    return Boolean(vs.slashMenuCommand && vs.slashMenuArgItems.length > 0);
  }
  return vs.slashMenuItems.length > 0;
}

function getActiveSlashMenuOptionId(): string | null {
  if (!isSlashMenuVisible()) {
    return null;
  }
  if (vs.slashMenuMode === "args") {
    const commandName = vs.slashMenuCommand?.name;
    const arg = vs.slashMenuArgItems[vs.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(commandName, arg) : null;
  }
  const cmd = vs.slashMenuItems[vs.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(cmd) : null;
}

function getActiveSlashMenuOptionLabel(): string {
  if (!isSlashMenuVisible()) {
    return "";
  }
  if (vs.slashMenuMode === "args") {
    const commandName = vs.slashMenuCommand?.name;
    const arg = vs.slashMenuArgItems[vs.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = vs.slashMenuItems[vs.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${cmd.description}`;
}

function scrollActiveSlashMenuOptionIntoView(): void {
  const activeId = getActiveSlashMenuOptionId();
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const menu = activeOption?.closest<HTMLElement>(".slash-menu");
    if (!activeOption || !menu) {
      return;
    }
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      menu.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

function tokenEstimate(draft: string): string | null {
  if (draft.length < 100) {
    return null;
  }
  return `~${Math.ceil(draft.length / 4)} tokens`;
}

/**
 * Export chat markdown - delegates to shared utility.
 */
function exportMarkdown(props: ChatProps): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatProps,
  draft: string,
): TemplateResult | typeof nothing {
  if (!vs.slashMenuOpen) {
    return nothing;
  }

  // Arg-picker mode: show options for the selected command
  if (vs.slashMenuMode === "args" && vs.slashMenuCommand && vs.slashMenuArgItems.length > 0) {
    return html`
      <div
        id=${SLASH_MENU_LISTBOX_ID}
        class="slash-menu"
        role="listbox"
        aria-label="Command arguments"
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            /${vs.slashMenuCommand.name} ${vs.slashMenuCommand.description}
          </div>
          ${vs.slashMenuArgItems.map(
            (arg, i) => html`
              <div
                id=${getSlashArgOptionId(vs.slashMenuCommand?.name ?? "", arg)}
                class="slash-menu-item ${i === vs.slashMenuIndex ? "slash-menu-item--active" : ""}"
                role="option"
                aria-selected=${i === vs.slashMenuIndex}
                @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                @mouseenter=${() => {
                  vs.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                ${vs.slashMenuCommand?.icon
                  ? html`<span class="slash-menu-icon"
                      >${renderSlashIcon(vs.slashMenuCommand.icon)}</span
                    >`
                  : nothing}
                <span class="slash-menu-name">${arg}</span>
                <span class="slash-menu-desc">/${vs.slashMenuCommand?.name} ${arg}</span>
              </div>
            `,
          )}
        </div>
        <div class="slash-menu-footer">
          <kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> run <kbd>Esc</kbd> close
        </div>
      </div>
    `;
  }

  // Command mode: show grouped commands
  if (vs.slashMenuItems.length === 0) {
    return nothing;
  }

  const grouped = new Map<
    SlashCommandCategory,
    Array<{ cmd: SlashCommandDef; globalIdx: number }>
  >();
  for (let i = 0; i < vs.slashMenuItems.length; i++) {
    const cmd = vs.slashMenuItems[i];
    const cat = cmd.category ?? "session";
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push({ cmd, globalIdx: i });
  }

  const sections: TemplateResult[] = [];
  for (const [cat, entries] of grouped) {
    sections.push(html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${CATEGORY_LABELS[cat]}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(cmd)}
              class="slash-menu-item ${globalIdx === vs.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === vs.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                vs.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              ${cmd.icon
                ? html`<span class="slash-menu-icon">${renderSlashIcon(cmd.icon)}</span>`
                : nothing}
              <span class="slash-menu-name">/${cmd.name}</span>
              ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              <span class="slash-menu-desc">${cmd.description}</span>
              ${cmd.argOptions?.length
                ? html`<span class="slash-menu-badge">${cmd.argOptions.length} options</span>`
                : cmd.executeLocal && !cmd.args
                  ? html` <span class="slash-menu-badge">instant</span> `
                  : nothing}
            </div>
          `,
        )}
      </div>
    `);
  }

  const hiddenCount = vs.slashMenuExpanded ? 0 : getHiddenCommandCount();

  return html`
    <div id=${SLASH_MENU_LISTBOX_ID} class="slash-menu" role="listbox" aria-label="Slash commands">
      ${sections}
      ${hiddenCount > 0
        ? html`<button
            class="slash-menu-show-more"
            @click=${(e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              vs.slashMenuExpanded = true;
              updateSlashMenu(draft, requestUpdate, props);
            }}
          >
            Show ${hiddenCount} more command${hiddenCount !== 1 ? "s" : ""}
          </button>`
        : nothing}
      <div class="slash-menu-footer">
        <kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> select <kbd>Esc</kbd> close
      </div>
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected && props.canSend;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const hasTerminalStatus = hasTerminalRunStatus(props.runStatus);
  const showAbortableUi = canAbort && !hasTerminalStatus;
  const showSubmittedProgressUi = props.queue.some((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const composerRunStatus =
    showAbortableUi || showSubmittedProgressUi
      ? { phase: "in-progress" as const }
      : props.runStatus;
  const compactBusy =
    props.compactionStatus?.phase === "active" || props.compactionStatus?.phase === "retrying";
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const visibleDraft = props.draft;
  let composerTextarea: HTMLTextAreaElement | null = null;
  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const tokens = tokenEstimate(visibleDraft);
  const composerControls = props.composerControls;

  const placeholder = !props.connected
    ? t("chat.composer.placeholderDisconnected")
    : !canCompose && props.disabledReason
      ? props.disabledReason
      : hasAttachments
        ? t("chat.composer.placeholderWithAttachments")
        : t("chat.composer.placeholder", { name: props.assistantName || "agent" });

  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = renderChatThread({
    sessionKey: props.sessionKey,
    loading: props.loading,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: props.stream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showThinking: props.showThinking,
    showToolCalls: props.showToolCalls,
    sessions: props.sessions,
    assistantName: props.assistantName,
    assistantAvatar: props.assistantAvatar,
    assistantAvatarUrl: props.assistantAvatarUrl,
    userName: props.userName,
    userAvatar: props.userAvatar,
    basePath: props.basePath,
    fullMessageAgentId: props.fullMessageAgentId,
    localMediaPreviewRoots: props.localMediaPreviewRoots,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode,
    allowExternalEmbedUrls: props.allowExternalEmbedUrls,
    autoExpandToolCalls: props.autoExpandToolCalls,
    realtimeTalkConversation: props.realtimeTalkConversation,
    onOpenSidebar: props.onOpenSidebar,
    onOpenSessionCheckpoints: props.onOpenSessionCheckpoints,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    onRequestUpdate: requestUpdate,
    onScrollToBottom: props.onScrollToBottom,
    onChatScroll: props.onChatScroll,
    onDraftChange: props.onDraftChange,
    onSend: props.onSend,
    onSetReply: props.onSetReply,
    onFocusComposer: () => composerTextarea?.focus(),
  });

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
    const hostDraft = props.getDraft?.() ?? props.draft;
    const draftKey = composerDraftKey(props);
    const clearedSubmittedDraft =
      hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
    if (clearedSubmittedDraft) {
      vs.pendingClearedSubmittedDraft = {
        key: draftKey,
        value: submittedDraft,
      };
    } else {
      clearPendingClearedSubmittedDraft(draftKey);
    }
    if (target && target.value !== hostDraft) {
      target.value = hostDraft;
      adjustTextareaHeight(target);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // IME navigation keys belong to the browser; downstream handlers can
    // prevent them or commit the in-progress composition as a host draft.
    if (vs.composerComposing || e.isComposing || e.keyCode === 229) {
      return;
    }

    // Slash menu navigation — arg mode
    if (vs.slashMenuOpen && vs.slashMenuMode === "args" && vs.slashMenuArgItems.length > 0) {
      const len = vs.slashMenuArgItems.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "ArrowUp":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "Tab":
          e.preventDefault();
          selectSlashArg(vs.slashMenuArgItems[vs.slashMenuIndex], props, requestUpdate, false);
          return;
        case "Enter":
          e.preventDefault();
          selectSlashArg(vs.slashMenuArgItems[vs.slashMenuIndex], props, requestUpdate, true);
          return;
        case "Escape":
          e.preventDefault();
          vs.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    // Slash menu navigation — command mode
    if (vs.slashMenuOpen && vs.slashMenuItems.length > 0) {
      const len = vs.slashMenuItems.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "ArrowUp":
          e.preventDefault();
          vs.slashMenuIndex = (vs.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "Tab":
          e.preventDefault();
          tabCompleteSlashCommand(vs.slashMenuItems[vs.slashMenuIndex], props, requestUpdate);
          return;
        case "Enter":
          e.preventDefault();
          selectSlashCommand(vs.slashMenuItems[vs.slashMenuIndex], props, requestUpdate);
          return;
        case "Escape":
          e.preventDefault();
          vs.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    if (e.key === "Escape" && props.sideResult && !isChatThreadSearchOpen()) {
      e.preventDefault();
      props.onDismissSideResult?.();
      return;
    }

    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && props.onHistoryKeydown) {
      const target = e.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      const result = props.onHistoryKeydown({
        key: e.key,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        valueLength: target.value.length,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
      });
      if (result.handled) {
        if (result.preventDefault) {
          e.preventDefault();
        }
        if (result.restoreCaret) {
          restoreHistoryCaret(target, result.restoreCaret);
        }
        return;
      }
    }

    // Cmd+F for search
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
      e.preventDefault();
      toggleChatThreadSearch(requestUpdate);
      return;
    }

    // Send on Enter (without shift)
    if (e.key === "Enter" && !e.shiftKey) {
      if (!canCompose) {
        return;
      }
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      props.onSend();
      syncComposerDraftAfterSend(target);
    }
  };

  const syncComposerValue = (target: HTMLTextAreaElement) => {
    adjustTextareaHeight(target);
    commitComposerDraft(props, target.value);
    updateSlashMenu(target.value, requestUpdate, props, {}, () => target.value);
  };
  const handleBeforeInput = (e: InputEvent) => {
    if (!vs.composerComposing && !e.isComposing) {
      markComposerInputIntent(composerDraftKey(props));
    }
  };
  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLTextAreaElement;
    const draftKey = composerDraftKey(props);
    const hasInputIntent = consumeComposerInputIntent(draftKey);
    if (vs.composerComposing || e.isComposing) {
      // Skip adjustTextareaHeight during IME composition — each pinyin
      // keystroke fires `input` and the height read/write forces a
      // synchronous reflow that blocks the composition thread.
      // Resize runs once in handleCompositionEnd → syncComposerValue.
      return;
    }
    if (
      suppressStaleSubmittedDraftReplay(
        target,
        e,
        props.getDraft?.() ?? props.draft,
        hasInputIntent,
      )
    ) {
      return;
    }
    syncComposerValue(target);
  };
  const handleCompositionEnd = (e: CompositionEvent) => {
    vs.composerComposing = false;
    syncComposerValue(e.target as HTMLTextAreaElement);
  };
  const handleBlur = (e: FocusEvent) => {
    const target = e.target as HTMLTextAreaElement;
    commitComposerDraft(props, target.value);
  };
  const handleSend = () => {
    if (!canCompose) {
      return;
    }
    commitComposerDraft(props, composerTextarea?.value ?? props.draft);
    props.onSend();
    syncComposerDraftAfterSend(composerTextarea);
  };
  const slashMenuVisible = canCompose && isSlashMenuVisible();
  const activeSlashMenuOptionId = getActiveSlashMenuOptionId();
  const activeSlashMenuOptionLabel = getActiveSlashMenuOptionLabel();
  const chatColumnFooter = html`
    ${renderChatQueue({
      queue: props.queue,
      canAbort: showAbortableUi,
      onQueueRetry: canCompose ? props.onQueueRetry : undefined,
      onQueueSteer: canCompose ? props.onQueueSteer : undefined,
      onQueueRemove: props.onQueueRemove,
    })}
    ${renderSideResult(props.sideResult, props.onDismissSideResult)}
    ${props.showNewMessages
      ? html`
          <button class="chat-new-messages" type="button" @click=${props.onScrollToBottom}>
            ${icons.arrowDown} New messages
          </button>
        `
      : nothing}

    <!-- Input bar -->
    <div
      class="agent-chat__input"
      @click=${(event: MouseEvent) => focusComposerFromChrome(event, canCompose)}
    >
      ${slashMenuVisible ? renderSlashMenu(requestUpdate, props, visibleDraft) : nothing}
      ${renderAttachmentPreview(props)}
      ${props.replyTarget
        ? html`
            <div class="chat-reply-preview">
              <span class="chat-reply-preview__icon">${icons.messageSquare}</span>
              <span class="chat-reply-preview__label"
                >Replying to ${props.replyTarget.senderLabel ?? "message"}</span
              >
              <span class="chat-reply-preview__text"
                >${props.replyTarget.text.slice(0, 120)}${props.replyTarget.text.length > 120
                  ? "…"
                  : ""}</span
              >
              <button
                type="button"
                class="chat-reply-preview__dismiss"
                @click=${() => props.onClearReply?.()}
                aria-label="Cancel reply"
                title="Cancel reply"
              >
                ${icons.x}
              </button>
            </div>
          `
        : nothing}
      <div class="agent-chat__composer-status-stack">
        ${renderFallbackIndicator(props.fallbackStatus)}
        ${renderCompactionIndicator(props.compactionStatus)} ${renderChatGoal(activeSession?.goal)}
      </div>

      <input
        type="file"
        accept=${CHAT_ATTACHMENT_ACCEPT}
        multiple
        class="agent-chat__file-input"
        ?disabled=${!canCompose}
        @change=${(e: Event) => {
          if (canCompose) {
            handleChatAttachmentFileSelect(e, props);
          }
        }}
      />

      ${renderRealtimeTalkOptions(props)}
      ${props.realtimeTalkActive || props.realtimeTalkDetail || props.realtimeTalkTranscript
        ? html`
            <div
              class="agent-chat__stt-interim agent-chat__talk-status"
              role=${props.realtimeTalkStatus === "error" ? "alert" : nothing}
            >
              <span class="agent-chat__talk-status-text">
                ${props.realtimeTalkDetail ??
                ((props.realtimeTalkConversation?.length ?? 0) === 0
                  ? props.realtimeTalkTranscript
                  : null) ??
                (props.realtimeTalkStatus === "thinking"
                  ? "Asking OpenClaw..."
                  : props.realtimeTalkStatus === "connecting"
                    ? "Connecting Talk..."
                    : "Talk live")}
              </span>
              ${props.realtimeTalkStatus === "error" && props.onDismissRealtimeTalkError
                ? html`
                    <openclaw-tooltip .content=${t("chat.composer.dismissTalkError")}>
                      <button
                        class="callout__dismiss"
                        type="button"
                        @click=${props.onDismissRealtimeTalkError}
                        aria-label=${t("chat.composer.dismissTalkError")}
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  `
                : nothing}
            </div>
          `
        : nothing}

      <div class="agent-chat__composer-combobox">
        <textarea
          ${ref((el) => {
            composerTextarea = el instanceof HTMLTextAreaElement ? el : null;
            if (composerTextarea) {
              adjustTextareaHeight(composerTextarea);
            }
          })}
          .value=${visibleDraft}
          dir=${detectTextDirection(visibleDraft)}
          ?disabled=${!canCompose}
          aria-autocomplete="list"
          aria-controls=${ifDefined(slashMenuVisible ? SLASH_MENU_LISTBOX_ID : undefined)}
          aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
          aria-describedby=${SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID}
          @keydown=${handleKeyDown}
          @beforeinput=${handleBeforeInput}
          @input=${handleInput}
          @compositionstart=${() => {
            vs.composerComposing = true;
          }}
          @compositionend=${handleCompositionEnd}
          @blur=${handleBlur}
          @paste=${(e: ClipboardEvent) => {
            if (canCompose) {
              handleChatAttachmentPaste(e, props);
            }
          }}
          placeholder=${placeholder}
          rows="1"
        ></textarea>
        <span
          id=${SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID}
          class="agent-chat__sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          >${activeSlashMenuOptionLabel}</span
        >
      </div>

      <div class="agent-chat__toolbar">
        <div class="agent-chat__toolbar-left">
          <openclaw-tooltip .content=${t("chat.composer.attachFile")}>
            <button
              type="button"
              class="agent-chat__input-btn"
              @click=${clickComposerFileInput}
              aria-label=${t("chat.composer.attachFile")}
              ?disabled=${!canCompose}
            >
              ${icons.paperclip}
              <span class="agent-chat__control-label">${t("chat.composer.attachFile")}</span>
            </button>
          </openclaw-tooltip>

          ${props.onToggleRealtimeTalk
            ? html`
                <openclaw-tooltip
                  .content=${props.realtimeTalkActive
                    ? t("chat.composer.stopTalk")
                    : t("chat.composer.startTalk")}
                >
                  <button
                    class="agent-chat__input-btn ${props.realtimeTalkActive
                      ? "agent-chat__input-btn--talk"
                      : ""}"
                    @click=${props.onToggleRealtimeTalk}
                    aria-label=${props.realtimeTalkActive
                      ? t("chat.composer.stopTalk")
                      : t("chat.composer.startTalk")}
                    ?disabled=${!canCompose && !props.realtimeTalkActive}
                  >
                    ${props.realtimeTalkActive ? icons.volume2 : icons.radio}
                    <span class="agent-chat__control-label"
                      >${props.realtimeTalkActive
                        ? t("chat.composer.stopTalk")
                        : t("chat.composer.startTalk")}</span
                    >
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          ${props.onToggleRealtimeTalkOptions
            ? html`
                <openclaw-tooltip content="Talk settings">
                  <button
                    class="agent-chat__input-btn ${props.realtimeTalkOptionsOpen
                      ? "agent-chat__input-btn--talk"
                      : ""}"
                    @click=${props.onToggleRealtimeTalkOptions}
                    aria-label="Talk settings"
                    aria-expanded=${props.realtimeTalkOptionsOpen ? "true" : "false"}
                    ?disabled=${!canCompose || props.realtimeTalkActive}
                  >
                    ${icons.settings}
                    <span class="agent-chat__control-label">Talk settings</span>
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          ${tokens ? html`<span class="agent-chat__token-count">${tokens}</span>` : nothing}
          ${renderChatRunStatusIndicator(composerRunStatus)}
        </div>

        ${composerControls && composerControls !== nothing
          ? html`<div class="agent-chat__composer-controls">${composerControls}</div>`
          : nothing}
        ${renderContextNotice(activeSession, props.sessions?.defaults?.contextTokens ?? null, {
          compactBusy,
          compactDisabled: !canCompose || isBusy || showAbortableUi,
          onCompact: props.onCompact,
        })}
        ${renderChatRunControls({
          canAbort: showAbortableUi,
          connected: canCompose,
          draft: visibleDraft,
          hasMessages: props.messages.length > 0,
          isBusy,
          sending: props.sending,
          onAbort: props.onAbort,
          onExport: () => exportMarkdown(props),
          onNewSession: props.onNewSession,
          onSend: handleSend,
          onStoreDraft: () => {},
          showSecondary: false,
        })}
      </div>
    </div>
  `;

  return html`
    <section
      class="card chat"
      style=${styleMap(
        props.chatMessageMaxWidth ? { "--chat-message-max-width": props.chatMessageMaxWidth } : {},
      )}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        if (canCompose) {
          handleChatAttachmentDrop(e, props);
        }
      }}
      @dragover=${(e: DragEvent) => e.preventDefault()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape" && props.replyTarget && !e.defaultPrevented) {
          e.preventDefault();
          props.onClearReply?.();
        }
      }}
    >
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${
        props.error
          ? html`
              <div class="callout danger callout--dismissible" role="alert">
                <span class="callout__content">${props.error}</span>
                ${props.onDismissError
                  ? html`
                      <openclaw-tooltip content="Dismiss error">
                        <button
                          class="callout__dismiss"
                          type="button"
                          @click=${props.onDismissError}
                          aria-label="Dismiss error"
                        >
                          ${icons.x}
                        </button>
                      </openclaw-tooltip>
                    `
                  : nothing}
              </div>
            `
          : nothing
      }
      ${
        props.focusMode && props.onToggleFocusMode
          ? html`
              <openclaw-tooltip content="Exit focus mode">
                <button
                  class="chat-focus-exit"
                  type="button"
                  @click=${props.onToggleFocusMode}
                  aria-label="Exit focus mode"
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            `
          : nothing
      }
      ${renderChatSearchBar(requestUpdate)}
      ${renderChatPinnedMessages(
        {
          sessionKey: props.sessionKey,
          messages: props.messages,
          userName: props.userName,
          userAvatar: props.userAvatar,
        },
        requestUpdate,
      )}

      <div
        class="chat-workbench ${
          props.sessionWorkspace?.collapsed ? "chat-workbench--workspace-collapsed" : ""
        }"
      >
        ${renderSessionWorkspaceRail(props.sessionWorkspace)}
        <div class="chat-workbench__main">
          <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 1 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${thread} ${chatColumnFooter}
            </div>

            ${
              sidebarOpen
                ? html`
                    <resizable-divider
                      .splitRatio=${splitRatio}
                      .label=${t("nav.resize")}
                      @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                    ></resizable-divider>
                    <openclaw-chat-detail-panel
                      class="chat-sidebar"
                      .content=${props.sidebarContent ?? null}
                      .loadFullMessage=${props.onLoadSidebarFullMessage ?? null}
                      .canvasPluginSurfaceUrl=${props.canvasPluginSurfaceUrl ?? null}
                      .embedSandboxMode=${props.embedSandboxMode ?? "scripts"}
                      .allowExternalEmbedUrls=${props.allowExternalEmbedUrls ?? false}
                      @chat-detail-panel-close=${() => props.onCloseSidebar?.()}
                    ></openclaw-chat-detail-panel>
                  `
                : nothing
            }
          </div>

      </div>
    </section>
  `;
}
