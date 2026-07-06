// Chat-owned composer, queue, status, context, and run controls.
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewaySessionRow, SessionGoal, SessionsListResult } from "../../../api/types.ts";
import { normalizeChatSendShortcut, type ChatSendShortcut } from "../../../app/settings.ts";
import { icons, type IconName } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import {
  CATEGORY_LABELS,
  SLASH_COMMANDS,
  getHiddenCommandCount,
  getSlashCommandCompletions,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import type { ChatSideResult } from "../../../lib/chat/side-result.ts";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { exportChatMarkdown } from "../export.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../input-history.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS, type ChatRunUiStatus } from "../run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "../tool-stream.ts";
import { renderRealtimeTalkOptions, type RealtimeTalkOptions } from "./chat-realtime-controls.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;
const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;
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
const SLASH_MENU_LISTBOX_ID = "chat-slash-menu-listbox";
const SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID = "chat-slash-active-announcement";
const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

export type ChatComposerProps = {
  sessionKey: string;
  currentAgentId: string;
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  stream: string | null;
  sideResult?: ChatSideResult | null;
  queue: ChatQueueItem[];
  draft: string;
  sessions: SessionsListResult | null;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  attachments?: ChatAttachment[];
  showNewMessages?: boolean;
  replyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkTranscript?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkOptionsOpen?: boolean;
  realtimeTalkOptions?: RealtimeTalkOptions;
  canOpenRealtimeTalkSettings?: boolean;
  composerControls?: TemplateResult | typeof nothing;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeTalkOptions?: () => void;
  onRealtimeTalkOptionsChange?: (next: Partial<RealtimeTalkOptions>) => void;
  onOpenRealtimeTalkSettings?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onDismissSideResult?: () => void;
  onNewSession: () => void;
  onClearReply?: () => void;
  onScrollToBottom?: () => void;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onGoalCommand?: (command: string) => void;
};

type PendingClearedSubmittedDraft = {
  key: string;
  value: string;
};

type ChatComposerState = {
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
  goalExpandedId: string | null;
};

function createChatComposerState(): ChatComposerState {
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
    goalExpandedId: null,
  };
}

const composerState = createChatComposerState();

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

function composerDraftKey(props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

function commitComposerDraft(props: ChatComposerProps, value: string): void {
  if (props.getDraft?.() === value || props.draft === value) {
    return;
  }
  props.onDraftChange(value);
}

function markComposerInputIntent(key: string): void {
  composerState.composerInputIntentKey = key;
}

function consumeComposerInputIntent(key: string): boolean {
  if (composerState.composerInputIntentKey !== key) {
    return false;
  }
  composerState.composerInputIntentKey = null;
  return true;
}

function clearPendingClearedSubmittedDraft(key: string): void {
  if (composerState.pendingClearedSubmittedDraft?.key === key) {
    composerState.pendingClearedSubmittedDraft = null;
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
  const pending = composerState.pendingClearedSubmittedDraft;
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

export function resetChatComposerState() {
  Object.assign(composerState, createChatComposerState());
  for (const timer of goalElapsedTimers.values()) {
    clearInterval(timer);
  }
  goalElapsedTimers.clear();
}

const composerTextareaResizeObservers = new WeakMap<HTMLTextAreaElement, ResizeObserver>();

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  updateTextareaOverflow(el);
}

function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (typeof ResizeObserver !== "function" || composerTextareaResizeObservers.has(el)) {
    return;
  }
  const observer = new ResizeObserver(() => updateTextareaOverflow(el));
  observer.observe(el);
  composerTextareaResizeObservers.set(el, observer);
}

function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  composerTextareaResizeObservers.get(el)?.disconnect();
  composerTextareaResizeObservers.delete(el);
}

function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el);
    }
  });
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

const goalElapsedTimers = new Map<HTMLElement, ReturnType<typeof setInterval>>();

function clearGoalElapsedTimer(el: HTMLElement) {
  const timer = goalElapsedTimers.get(el);
  if (timer !== undefined) {
    clearInterval(timer);
    goalElapsedTimers.delete(el);
  }
}

// Ticks the elapsed span in place so an idle active goal does not force
// full chat re-renders every second.
function createGoalElapsedRef(goal: SessionGoal) {
  let bound: HTMLElement | null = null;
  return (element: Element | undefined) => {
    if (bound) {
      clearGoalElapsedTimer(bound);
      bound = null;
    }
    if (!(element instanceof HTMLElement) || goal.status !== "active") {
      return;
    }
    bound = element;
    const timer = setInterval(() => {
      // Tests and detached renders can drop the pill without a final ref call.
      if (!element.isConnected) {
        clearGoalElapsedTimer(element);
        return;
      }
      element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    }, 1000);
    goalElapsedTimers.set(element, timer);
  };
}

type ChatGoalActions = {
  canAct: boolean;
  onGoalCommand?: (command: string) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  requestUpdate: () => void;
};

function renderChatGoalActionButton(options: {
  className: string;
  label: string;
  icon: TemplateResult;
  onClick: () => void;
}): TemplateResult {
  return html`
    <openclaw-tooltip content=${options.label}>
      <button
        class="agent-chat__goal-action ${options.className}"
        type="button"
        aria-label=${options.label}
        @click=${options.onClick}
      >
        ${options.icon}
      </button>
    </openclaw-tooltip>
  `;
}

function renderChatGoal(
  goal: SessionGoal | undefined,
  actions: ChatGoalActions,
): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  const elapsed = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
  const usage = formatGoalUsage(goal);
  const expanded = composerState.goalExpandedId === goal.id;
  const showActions = actions.canAct && Boolean(actions.onGoalCommand);
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited";
  const toggleExpanded = () => {
    composerState.goalExpandedId = expanded ? null : goal.id;
    actions.requestUpdate();
  };
  return html`
    <div
      class="agent-chat__goal agent-chat__goal--${goal.status}"
      role="group"
      aria-label=${formatGoalDetail(goal)}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon">${icons.target}</span>
        <span class="agent-chat__goal-label">${formatGoalStatusLabel(goal.status)}</span>
        <span class="agent-chat__goal-objective">${goal.objective}</span>
        <span class="agent-chat__goal-elapsed" ${ref(createGoalElapsedRef(goal))}>${elapsed}</span>
        <span class="agent-chat__goal-actions">
          ${showActions && actions.onGoalEdit && goal.status !== "complete"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-edit",
                label: "Edit goal",
                icon: icons.penLine,
                onClick: () => actions.onGoalEdit?.(goal),
              })
            : nothing}
          ${showActions && goal.status === "active"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-pause",
                label: "Pause goal",
                icon: icons.pause,
                onClick: () => actions.onGoalCommand?.("/goal pause"),
              })
            : nothing}
          ${showActions && canResume
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-resume",
                label: "Resume goal",
                icon: icons.play,
                onClick: () => actions.onGoalCommand?.("/goal resume"),
              })
            : nothing}
          ${showActions
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-clear",
                label: "Clear goal",
                icon: icons.trash,
                onClick: () => actions.onGoalCommand?.("/goal clear"),
              })
            : nothing}
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded=${expanded ? "true" : "false"}
            aria-label=${expanded ? "Hide goal details" : "Show goal details"}
            @click=${toggleExpanded}
          >
            ${expanded ? icons.chevronDown : icons.chevronRight}
          </button>
        </span>
      </div>
      ${expanded
        ? html`
            <div class="agent-chat__goal-detail">
              <div class="agent-chat__goal-detail-objective">${goal.objective}</div>
              ${goal.lastStatusNote
                ? html`<div class="agent-chat__goal-detail-note">${goal.lastStatusNote}</div>`
                : nothing}
              <div class="agent-chat__goal-detail-meta">
                ${usage ? `${usage} · ${elapsed}` : elapsed}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

function resetSlashMenuState(): void {
  composerState.slashMenuMode = "command";
  composerState.slashMenuCommand = null;
  composerState.slashMenuArgItems = [];
  composerState.slashMenuItems = [];
  composerState.slashMenuExpanded = false;
}

function hasVisibleSlashMenuState(): boolean {
  return (
    composerState.slashMenuOpen ||
    composerState.slashMenuMode !== "command" ||
    composerState.slashMenuCommand !== null ||
    composerState.slashMenuArgItems.length > 0 ||
    composerState.slashMenuItems.length > 0 ||
    composerState.slashMenuExpanded
  );
}

function closeSlashMenuIfNeeded(requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState()) {
    return;
  }
  composerState.slashMenuOpen = false;
  resetSlashMenuState();
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  if (!props.onSlashIntent || composerState.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  composerState.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    composerState.slashCommandRefreshPending = false;
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
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1].toLowerCase();
    const argFilter = argMatch[2].toLowerCase();
    const cmd = SLASH_COMMANDS.find((entry) => entry.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        composerState.slashMenuMode = "args";
        composerState.slashMenuCommand = cmd;
        composerState.slashMenuArgItems = filtered;
        composerState.slashMenuOpen = true;
        composerState.slashMenuIndex = 0;
        composerState.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }

  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1], {
      showAll: composerState.slashMenuExpanded,
    });
    composerState.slashMenuItems = items;
    composerState.slashMenuOpen = items.length > 0;
    composerState.slashMenuIndex = 0;
    composerState.slashMenuMode = "command";
    composerState.slashMenuCommand = null;
    composerState.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(requestUpdate);
    return;
  }
  requestUpdate();
}

function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    composerState.slashMenuMode = "args";
    composerState.slashMenuCommand = cmd;
    composerState.slashMenuArgItems = cmd.argOptions;
    composerState.slashMenuOpen = true;
    composerState.slashMenuIndex = 0;
    composerState.slashMenuItems = [];
    requestUpdate();
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    composerState.slashMenuOpen = false;
    resetSlashMenuState();
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(requestUpdate);
  }
}

function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    composerState.slashMenuMode = "args";
    composerState.slashMenuCommand = cmd;
    composerState.slashMenuArgItems = cmd.argOptions;
    composerState.slashMenuOpen = true;
    composerState.slashMenuIndex = 0;
    composerState.slashMenuItems = [];
    requestUpdate();
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  composerState.slashMenuOpen = false;
  resetSlashMenuState();
  requestUpdate();
}

function selectSlashArg(
  arg: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  run: boolean,
) {
  const cmdName = composerState.slashMenuCommand?.name ?? "";
  composerState.slashMenuOpen = false;
  resetSlashMenuState();
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  if (run) {
    props.onSend();
  }
  requestUpdate();
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
  if (!composerState.slashMenuOpen) {
    return false;
  }
  if (composerState.slashMenuMode === "args") {
    return Boolean(composerState.slashMenuCommand && composerState.slashMenuArgItems.length > 0);
  }
  return composerState.slashMenuItems.length > 0;
}

function getActiveSlashMenuOptionId(): string | null {
  if (!isSlashMenuVisible()) {
    return null;
  }
  if (composerState.slashMenuMode === "args") {
    const commandName = composerState.slashMenuCommand?.name;
    const arg = composerState.slashMenuArgItems[composerState.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(commandName, arg) : null;
  }
  const cmd = composerState.slashMenuItems[composerState.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(cmd) : null;
}

function getActiveSlashMenuOptionLabel(): string {
  if (!isSlashMenuVisible()) {
    return "";
  }
  if (composerState.slashMenuMode === "args") {
    const commandName = composerState.slashMenuCommand?.name;
    const arg = composerState.slashMenuArgItems[composerState.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = composerState.slashMenuItems[composerState.slashMenuIndex];
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

function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  if (!composerState.slashMenuOpen) {
    return nothing;
  }

  if (
    composerState.slashMenuMode === "args" &&
    composerState.slashMenuCommand &&
    composerState.slashMenuArgItems.length > 0
  ) {
    return html`
      <div
        id=${SLASH_MENU_LISTBOX_ID}
        class="slash-menu"
        role="listbox"
        aria-label="Command arguments"
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            /${composerState.slashMenuCommand.name} ${composerState.slashMenuCommand.description}
          </div>
          ${composerState.slashMenuArgItems.map(
            (arg, i) => html`
              <div
                id=${getSlashArgOptionId(composerState.slashMenuCommand?.name ?? "", arg)}
                class="slash-menu-item ${i === composerState.slashMenuIndex
                  ? "slash-menu-item--active"
                  : ""}"
                role="option"
                aria-selected=${i === composerState.slashMenuIndex}
                @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                @mouseenter=${() => {
                  composerState.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                ${composerState.slashMenuCommand?.icon
                  ? html`<span class="slash-menu-icon"
                      >${renderSlashIcon(composerState.slashMenuCommand.icon)}</span
                    >`
                  : nothing}
                <span class="slash-menu-name">${arg}</span>
                <span class="slash-menu-desc">/${composerState.slashMenuCommand?.name} ${arg}</span>
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

  if (composerState.slashMenuItems.length === 0) {
    return nothing;
  }

  const grouped = new Map<
    SlashCommandCategory,
    Array<{ cmd: SlashCommandDef; globalIdx: number }>
  >();
  for (let i = 0; i < composerState.slashMenuItems.length; i++) {
    const cmd = composerState.slashMenuItems[i];
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
              class="slash-menu-item ${globalIdx === composerState.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === composerState.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                composerState.slashMenuIndex = globalIdx;
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

  const hiddenCount = composerState.slashMenuExpanded ? 0 : getHiddenCommandCount();

  return html`
    <div id=${SLASH_MENU_LISTBOX_ID} class="slash-menu" role="listbox" aria-label="Slash commands">
      ${sections}
      ${hiddenCount > 0
        ? html`<button
            class="slash-menu-show-more"
            @click=${(event: Event) => {
              event.preventDefault();
              event.stopPropagation();
              composerState.slashMenuExpanded = true;
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

export type ChatAttachmentControlsProps = {
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
};

type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

function sendStateLabel(item: ChatQueueItem): string | null {
  switch (item.sendState) {
    case "waiting-model":
      return "Waiting for model";
    case "waiting-reconnect":
      return "Waiting for reconnect";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

export function renderChatQueue(props: ChatQueueProps) {
  const visibleQueue = props.queue.filter((item) => item.sendState !== "sending");
  if (!visibleQueue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">Queued (${visibleQueue.length})</div>
      <div class="chat-queue__list">
        ${visibleQueue.map((item) => {
          const stateLabel = sendStateLabel(item);
          return html`
            <div
              class="chat-queue__item ${item.kind === "steered" ? "chat-queue__item--steered" : ""}"
            >
              <div class="chat-queue__main">
                ${item.kind === "steered"
                  ? html`<span class="chat-queue__badge">Steered</span>`
                  : nothing}
                ${stateLabel ? html`<span class="chat-queue__badge">${stateLabel}</span>` : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                </div>
                ${item.sendError
                  ? html`<div class="chat-queue__error">${item.sendError}</div>`
                  : nothing}
              </div>
              <div class="chat-queue__actions">
                ${item.sendState === "failed" && props.onQueueRetry
                  ? html`
                      <button
                        class="btn chat-queue__retry"
                        type="button"
                        aria-label=${t("chat.queue.retryQueuedMessage")}
                        @click=${() => props.onQueueRetry?.(item.id)}
                      >
                        ${icons.refresh}
                        <span>${t("chat.queue.retry")}</span>
                      </button>
                    `
                  : nothing}
                ${props.canAbort &&
                props.onQueueSteer &&
                item.kind !== "steered" &&
                !item.sendState &&
                !item.localCommandName
                  ? html`
                      <button
                        class="btn chat-queue__steer"
                        type="button"
                        aria-label="Steer queued message"
                        @click=${() => props.onQueueSteer?.(item.id)}
                      >
                        ${icons.cornerDownRight}
                        <span>Steer</span>
                      </button>
                    `
                  : nothing}
                <openclaw-tooltip content="Remove queued message">
                  <button
                    class="btn chat-queue__remove"
                    type="button"
                    aria-label="Remove queued message"
                    @click=${() => props.onQueueRemove(item.id)}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

export function renderSideResult(
  sideResult: ChatSideResult | null | undefined,
  onDismiss?: () => void,
): TemplateResult | typeof nothing {
  if (!sideResult) {
    return nothing;
  }
  return html`
    <section
      class=${`chat-side-result ${sideResult.isError ? "chat-side-result--error" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="BTW side result"
    >
      <div class="chat-side-result__header">
        <div class="chat-side-result__label-row">
          <span class="chat-side-result__label">BTW</span>
          <span class="chat-side-result__meta">Not saved to chat history</span>
        </div>
        <openclaw-tooltip content="Dismiss">
          <button
            class="btn chat-side-result__dismiss"
            type="button"
            aria-label="Dismiss BTW result"
            @click=${() => onDismiss?.()}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      </div>
      <div class="chat-side-result__question">${sideResult.question}</div>
      <div class="chat-side-result__body" dir=${detectTextDirection(sideResult.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(sideResult.text))}
      </div>
    </section>
  `;
}

function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

function clickComposerFileInput(event: MouseEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target
    .closest(".agent-chat__input")
    ?.querySelector<HTMLInputElement>(".agent-chat__file-input")
    ?.click();
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function chatAttachmentFromFile(file: File, dataUrl: string): ChatAttachment {
  const attachment = {
    id: generateAttachmentId(),
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || undefined,
    sizeBytes: file.size,
  };
  return registerChatAttachmentPayload({ attachment, dataUrl, file });
}

function dataImageClipboardFile(dataUrl: string): { file: File; dataUrl: string } | null {
  const match = /^\s*data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\s*$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  if (!isSupportedChatAttachmentFile({ name: "pasted-image", type: mimeType })) {
    return null;
  }
  const base64 = match[2].replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `pasted-image.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

function isImageAttachment(att: ChatAttachment): boolean {
  return att.mimeType.startsWith("image/");
}

function handleChatAttachmentPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }
  const imageItems: DataTransferItem[] = [];
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }
  if (imageItems.length === 0) {
    const text = e.clipboardData?.getData("text/plain");
    const pasted = text ? dataImageClipboardFile(text) : null;
    if (!pasted) {
      return;
    }
    e.preventDefault();
    props.onAttachmentsChange([
      ...(props.attachments ?? []),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
    return;
  }
  e.preventDefault();
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment = chatAttachmentFromFile(file, dataUrl);
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target as HTMLInputElement;
  if (!input.files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of input.files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
  input.value = "";
}

export function handleChatAttachmentDrop(e: DragEvent, props: ChatAttachmentControlsProps) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-attachments-preview">
      ${attachments.map(
        (att) => html`
          <div
            class=${[
              "chat-attachment-thumb",
              isImageAttachment(att) ? "" : "chat-attachment-thumb--file",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            ${isImageAttachment(att) && getChatAttachmentPreviewUrl(att)
              ? html`<img src=${getChatAttachmentPreviewUrl(att)!} alt="Attachment preview" />`
              : html`
                  <openclaw-tooltip .content=${att.fileName ?? "Attached file"}>
                    <div class="chat-attachment-file">
                      <span class="chat-attachment-file__icon">${icons.paperclip}</span>
                      <span class="chat-attachment-file__name"
                        >${att.fileName ?? "Attached file"}</span
                      >
                    </div>
                  </openclaw-tooltip>
                `}
            <openclaw-tooltip content="Remove attachment">
              <button
                class="chat-attachment-remove"
                type="button"
                aria-label="Remove attachment"
                @click=${() => {
                  const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                  releaseChatAttachmentPayload(att.id);
                  props.onAttachmentsChange?.(next);
                }}
              >
                &times;
              </button>
            </openclaw-tooltip>
          </div>
        `,
      )}
    </div>
  `;
}

type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

export function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase !== "in-progress") {
    const elapsed = Date.now() - status.occurredAt;
    if (elapsed >= CHAT_RUN_STATUS_TOAST_DURATION_MS) {
      return nothing;
    }
  }
  const label =
    status.phase === "in-progress"
      ? "In progress"
      : status.phase === "done"
        ? "Done"
        : "Interrupted";
  const icon =
    status.phase === "in-progress"
      ? icons.loader
      : status.phase === "done"
        ? icons.check
        : icons.stop;
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--${status.phase}"
      role="status"
      aria-live="polite"
      aria-label=${`Run status: ${label}`}
    >
      ${icon}<span class="agent-chat__run-status-label">${label}</span>
    </span>
  `;
}

export function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "active" || status.phase === "retrying") {
    return html`
      <div
        class="compaction-indicator compaction-indicator--active"
        role="status"
        aria-live="polite"
      >
        ${icons.loader} Compacting context...
      </div>
    `;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div
          class="compaction-indicator compaction-indicator--complete"
          role="status"
          aria-live="polite"
        >
          ${icons.check} Context compacted
        </div>
      `;
    }
  }
  return nothing;
}

export function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <openclaw-tooltip .content=${details}>
      <div class=${className} role="status" aria-live="polite" aria-label=${details}>
        ${icon} ${message}
      </div>
    </openclaw-tooltip>
  `;
}

type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  messages?: unknown[];
  onCompact?: () => void | Promise<void>;
};

type ProviderCostStats = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider: string | null;
  model: string | null;
};

function readCostRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readCostValue(
  cost: Record<string, unknown> | null,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
) {
  const value = cost?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latestProviderCostStats(messages: unknown[] | undefined): ProviderCostStats | null {
  if (!messages?.length) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages[index]);
    if (message?.role === "user") {
      return null;
    }
    if (message?.role !== "assistant") {
      continue;
    }
    const directCost = readCostRecord(message.cost);
    const usageCost = readCostRecord(readCostRecord(message.usage)?.cost);
    const stats: ProviderCostStats = {
      provider: typeof message.provider === "string" ? message.provider.trim() || null : null,
      model:
        (typeof message.responseModel === "string" ? message.responseModel.trim() : "") ||
        (typeof message.model === "string" ? message.model.trim() : "") ||
        null,
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const cost = readCostValue(directCost, key) ?? readCostValue(usageCost, key);
      if (cost !== undefined) {
        stats[key] = cost;
      }
    }
    if (
      [stats.input, stats.output, stats.cacheRead, stats.cacheWrite].some((value) => value != null)
    ) {
      return stats;
    }
  }
  return null;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

export function resetContextNoticeThemeCacheForTest(): void {
  cachedThemeNoticeColors = null;
}

export function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  used: number;
  limit: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  provider: string | null;
  model: string | null;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
  approximate: boolean;
} | null {
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const approximate = session?.totalTokensFresh === false;
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost =
    typeof session?.estimatedCostUsd === "number" &&
    Number.isFinite(session.estimatedCostUsd) &&
    session.estimatedCostUsd >= 0
      ? session.estimatedCostUsd
      : null;
  const usage = {
    used,
    limit,
    input,
    output,
    cost,
    provider: session?.modelProvider?.trim() || null,
    model: session?.model?.trim() || null,
  };
  if (!warning) {
    return {
      pct,
      ...usage,
      detail: `${approximate ? "~" : ""}${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
      approximate,
    };
  }
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const mix = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * mix);
  const g = Math.round(wg + (dg - wg) * mix);
  const b = Math.round(wb + (db - wb) * mix);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * mix;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    ...usage,
    detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
    approximate,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  if (!model) {
    return nothing;
  }
  const canRenderCompact = model.compactRecommended && options.onCompact;
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  const summary = t("chat.composer.contextUsage.summary", {
    used: `${model.approximate ? "~" : ""}${formatCompactTokenCount(model.used)}`,
    limit: formatCompactTokenCount(model.limit),
    pct: `${model.approximate ? "~" : ""}${model.pct}`,
  });
  const percentage = `${model.approximate ? "~" : ""}${model.pct}%`;
  const dashOffset = RING_CIRCUMFERENCE * (1 - model.pct / 100);
  const providerCosts = latestProviderCostStats(options.messages);
  const provider = providerCosts?.provider ?? model.provider;
  const responseModel = providerCosts?.model ?? model.model;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const renderCostStat = (label: string, value: number | undefined) =>
    value === undefined
      ? nothing
      : html`
          <div>
            <dt>${label}</dt>
            <dd>${formatCost(value)}</dd>
          </div>
        `;
  return html`
    <div class="context-usage" style="--ctx-color:${model.color};--ctx-bg:${model.bg}">
      <details>
        <summary
          class="context-ring ${model.warning ? "context-ring--warning" : ""}"
          aria-label=${summary}
          title=${t("chat.composer.contextUsage.open")}
        >
          <svg
            class="context-ring__dial"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
            <circle
              class="context-ring__fill"
              cx="8"
              cy="8"
              r=${RING_RADIUS}
              stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
              stroke-dashoffset=${dashOffset.toFixed(2)}
            />
          </svg>
          <span class="context-ring__pct">${percentage}</span>
        </summary>
        <section class="context-usage__popover" aria-label=${t("chat.composer.contextUsage.title")}>
          <div class="context-usage__header">
            <span class="context-usage__title"
              >${t("chat.composer.contextUsage.contextWindow")}</span
            >
            <strong class="context-usage__context-value">${model.detail} · ${percentage}</strong>
          </div>
          <div
            class="context-usage__bar"
            role="progressbar"
            aria-label=${summary}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${model.pct}
          >
            <span style="width: ${model.pct}%"></span>
          </div>
          <div class="context-usage__section-label">
            ${t("chat.composer.contextUsage.latestRunTokens")}
          </div>
          <dl class="context-usage__stats">
            <div>
              <dt>${t("usage.breakdown.input")}</dt>
              <dd>${formatStat(model.input)}</dd>
            </div>
            <div>
              <dt>${t("usage.breakdown.output")}</dt>
              <dd>${formatStat(model.output)}</dd>
            </div>
            ${model.cost === null
              ? nothing
              : html`
                  <div>
                    <dt>${t("chat.composer.contextUsage.estimatedCost")}</dt>
                    <dd>${formatCost(model.cost)}</dd>
                  </div>
                `}
          </dl>
          ${providerCosts
            ? html`
                <div class="context-usage__section-label">${t("usage.breakdown.costByType")}</div>
                <dl class="context-usage__stats context-usage__stats--cost">
                  ${renderCostStat(t("usage.breakdown.input"), providerCosts.input)}
                  ${renderCostStat(t("usage.breakdown.output"), providerCosts.output)}
                  ${renderCostStat(t("usage.breakdown.cacheRead"), providerCosts.cacheRead)}
                  ${renderCostStat(t("usage.breakdown.cacheWrite"), providerCosts.cacheWrite)}
                </dl>
              `
            : nothing}
          ${provider
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.provider")}</span>
                  <strong>${provider}</strong>
                </div>
              `
            : nothing}
          ${responseModel
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.model")}</span>
                  <strong>${responseModel}</strong>
                </div>
              `
            : nothing}
        </section>
      </details>
      ${canRenderCompact
        ? html`
            <button
              class="context-ring__action ${options.compactBusy
                ? "context-ring__action--busy"
                : ""}"
              type="button"
              aria-label="Compact recommended session context"
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}

export type ChatRunControlsProps = {
  canAbort: boolean;
  connected: boolean;
  draft: string;
  hasMessages: boolean;
  isBusy: boolean;
  sending: boolean;
  onAbort?: () => void;
  onExport: () => void;
  onNewSession: () => void;
  onSend: () => void;
  onStoreDraft: (draft: string) => void;
  showSecondary?: boolean;
};

export function renderChatRunControls(props: ChatRunControlsProps) {
  const showSecondary = props.showSecondary ?? true;
  const storeDraftAndSend = () => {
    if (props.draft.trim()) {
      props.onStoreDraft(props.draft);
    }
    props.onSend();
  };

  return html`
    <div class="agent-chat__toolbar-right">
      ${showSecondary && !props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.newSession")}>
              <button
                class="btn btn--ghost"
                @click=${props.onNewSession}
                aria-label=${t("chat.runControls.newSession")}
              >
                ${icons.plus}
                <span class="agent-chat__control-label">${t("chat.runControls.newSession")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${showSecondary
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.export")}>
              <button
                class="btn btn--ghost"
                @click=${props.onExport}
                aria-label=${t("chat.runControls.exportChat")}
                ?disabled=${!props.hasMessages}
              >
                ${icons.download}
                <span class="agent-chat__control-label">${t("chat.runControls.export")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.queue")}>
              <button
                class="chat-send-btn"
                @click=${storeDraftAndSend}
                ?disabled=${!props.connected || props.sending}
                aria-label=${t("chat.runControls.queueMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label">${t("chat.runControls.queue")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${t("chat.runControls.stop")}>
              <button
                class="chat-send-btn chat-send-btn--stop"
                @click=${props.onAbort}
                aria-label=${t("chat.runControls.stopGenerating")}
              >
                ${icons.stop}
                <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
              </button>
            </openclaw-tooltip>
          `
        : html`
            <openclaw-tooltip
              .content=${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}
            >
              <button
                class="chat-send-btn"
                @click=${storeDraftAndSend}
                ?disabled=${!props.connected || props.sending}
                aria-label=${props.isBusy
                  ? t("chat.runControls.queueMessage")
                  : t("chat.runControls.sendMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label"
                  >${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}</span
                >
              </button>
            </openclaw-tooltip>
          `}
    </div>
  `;
}

export function renderChatComposer(props: ChatComposerProps) {
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
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const sendShortcut = normalizeChatSendShortcut(props.sendShortcut);

  const placeholder = !props.connected
    ? t("chat.composer.placeholderDisconnected")
    : !canCompose && props.disabledReason
      ? props.disabledReason
      : hasAttachments
        ? t("chat.composer.placeholderWithAttachments")
        : t("chat.composer.placeholder", { name: props.assistantName || "agent" });

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
    const hostDraft = props.getDraft?.() ?? props.draft;
    const draftKey = composerDraftKey(props);
    const clearedSubmittedDraft =
      hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
    if (clearedSubmittedDraft) {
      composerState.pendingClearedSubmittedDraft = {
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

  const handleKeyDown = (event: KeyboardEvent) => {
    if (composerState.composerComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    if (
      composerState.slashMenuOpen &&
      composerState.slashMenuMode === "args" &&
      composerState.slashMenuArgItems.length > 0
    ) {
      const len = composerState.slashMenuArgItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          composerState.slashMenuIndex = (composerState.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "ArrowUp":
          event.preventDefault();
          composerState.slashMenuIndex = (composerState.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "Tab":
          event.preventDefault();
          selectSlashArg(
            composerState.slashMenuArgItems[composerState.slashMenuIndex],
            props,
            requestUpdate,
            false,
          );
          return;
        case "Enter":
          event.preventDefault();
          selectSlashArg(
            composerState.slashMenuArgItems[composerState.slashMenuIndex],
            props,
            requestUpdate,
            true,
          );
          return;
        case "Escape":
          event.preventDefault();
          composerState.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    if (composerState.slashMenuOpen && composerState.slashMenuItems.length > 0) {
      const len = composerState.slashMenuItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          composerState.slashMenuIndex = (composerState.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "ArrowUp":
          event.preventDefault();
          composerState.slashMenuIndex = (composerState.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView();
          return;
        case "Tab":
          event.preventDefault();
          tabCompleteSlashCommand(
            composerState.slashMenuItems[composerState.slashMenuIndex],
            props,
            requestUpdate,
          );
          return;
        case "Enter":
          event.preventDefault();
          selectSlashCommand(
            composerState.slashMenuItems[composerState.slashMenuIndex],
            props,
            requestUpdate,
          );
          return;
        case "Escape":
          event.preventDefault();
          composerState.slashMenuOpen = false;
          resetSlashMenuState();
          requestUpdate();
          return;
      }
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && props.onHistoryKeydown) {
      const target = event.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      const result = props.onHistoryKeydown({
        key: event.key,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        valueLength: target.value.length,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      });
      if (result.handled) {
        if (result.preventDefault) {
          event.preventDefault();
        }
        if (result.restoreCaret) {
          restoreHistoryCaret(target, result.restoreCaret);
        }
        return;
      }
    }

    const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
      if (!canCompose) {
        return;
      }
      event.preventDefault();
      const target = event.target as HTMLTextAreaElement;
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
  const handleBeforeInput = (event: InputEvent) => {
    if (!composerState.composerComposing && !event.isComposing) {
      markComposerInputIntent(composerDraftKey(props));
    }
  };
  const handleInput = (event: InputEvent) => {
    const target = event.target as HTMLTextAreaElement;
    const draftKey = composerDraftKey(props);
    const hasInputIntent = consumeComposerInputIntent(draftKey);
    if (composerState.composerComposing || event.isComposing) {
      return;
    }
    if (
      suppressStaleSubmittedDraftReplay(
        target,
        event,
        props.getDraft?.() ?? props.draft,
        hasInputIntent,
      )
    ) {
      return;
    }
    syncComposerValue(target);
  };
  const handleCompositionEnd = (event: CompositionEvent) => {
    composerState.composerComposing = false;
    syncComposerValue(event.target as HTMLTextAreaElement);
  };
  const handleBlur = (event: FocusEvent) => {
    const target = event.target as HTMLTextAreaElement;
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

  return html`
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
                  ? "..."
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
        ${renderCompactionIndicator(props.compactionStatus)}
        ${renderChatGoal(activeSession?.goal, {
          canAct: canCompose,
          onGoalCommand: props.onGoalCommand,
          onGoalEdit: (goal) => {
            commitComposerDraft(props, `/goal edit ${goal.objective}`);
            requestUpdate();
            queueMicrotask(() => composerTextarea?.focus({ preventScroll: true }));
          },
          requestUpdate,
        })}
      </div>

      <input
        type="file"
        accept=${CHAT_ATTACHMENT_ACCEPT}
        multiple
        class="agent-chat__file-input"
        ?disabled=${!canCompose}
        @change=${(event: Event) => {
          if (canCompose) {
            handleChatAttachmentFileSelect(event, props);
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
          ${ref((element) => {
            const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
            if (composerTextarea && composerTextarea !== nextTextarea) {
              disconnectTextareaOverflowObserver(composerTextarea);
            }
            composerTextarea = nextTextarea;
            if (composerTextarea) {
              observeTextareaOverflow(composerTextarea);
              scheduleTextareaHeightAdjustment(composerTextarea);
            }
          })}
          .value=${visibleDraft}
          dir=${detectTextDirection(visibleDraft)}
          ?disabled=${!canCompose}
          aria-autocomplete="list"
          aria-controls=${ifDefined(slashMenuVisible ? SLASH_MENU_LISTBOX_ID : undefined)}
          aria-activedescendant=${ifDefined(activeSlashMenuOptionId ?? undefined)}
          aria-describedby=${SLASH_MENU_ACTIVE_ANNOUNCEMENT_ID}
          aria-keyshortcuts=${sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter"}
          @keydown=${handleKeyDown}
          @beforeinput=${handleBeforeInput}
          @input=${handleInput}
          @compositionstart=${() => {
            composerState.composerComposing = true;
          }}
          @compositionend=${handleCompositionEnd}
          @blur=${handleBlur}
          @paste=${(event: ClipboardEvent) => {
            if (canCompose) {
              handleChatAttachmentPaste(event, props);
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

          ${props.onToggleRealtimeTalk || props.onToggleRealtimeTalkOptions
            ? html`
                <div class="agent-chat__talk-group">
                  ${props.onToggleRealtimeTalk
                    ? html`
                        <openclaw-tooltip
                          .content=${props.realtimeTalkActive
                            ? t("chat.composer.stopTalk")
                            : t("chat.composer.startTalk")}
                        >
                          <button
                            class="agent-chat__input-btn agent-chat__talk-toggle ${props.realtimeTalkActive
                              ? "agent-chat__input-btn--talk"
                              : ""}"
                            @click=${props.onToggleRealtimeTalk}
                            aria-label=${props.realtimeTalkActive
                              ? t("chat.composer.stopTalk")
                              : t("chat.composer.startTalk")}
                            ?disabled=${!canCompose && !props.realtimeTalkActive}
                          >
                            ${props.realtimeTalkActive ? icons.volume2 : icons.mic}
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
                            class="agent-chat__input-btn agent-chat__talk-caret ${props.realtimeTalkOptionsOpen
                              ? "agent-chat__input-btn--open"
                              : ""}"
                            @click=${props.onToggleRealtimeTalkOptions}
                            aria-label="Talk settings"
                            aria-expanded=${props.realtimeTalkOptionsOpen ? "true" : "false"}
                            ?disabled=${!canCompose || props.realtimeTalkActive}
                          >
                            ${icons.chevronDown}
                            <span class="agent-chat__control-label">Talk settings</span>
                          </button>
                        </openclaw-tooltip>
                      `
                    : nothing}
                </div>
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
          messages: props.messages,
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
}
