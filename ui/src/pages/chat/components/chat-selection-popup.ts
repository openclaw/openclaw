// Document-owned selection toolbar and annotation editor. The transcript owner
// tears both down together when its session or presentation changes.
import { render } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../../lib/keyboard-shortcut-contract.ts";

registerChatMessageMetadataEnglish();

type ChatSelectionPopupActions = {
  onAddToChat?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
  onAskSideChat: (selection: string) => void;
};

let activeSelectionPopup: { element: HTMLDivElement; listeners: AbortController } | null = null;
let selectionPopupTimer: number | null = null;

export function removeChatSelectionPopup() {
  if (selectionPopupTimer !== null) {
    window.clearTimeout(selectionPopupTimer);
    selectionPopupTimer = null;
  }
  activeSelectionPopup?.element.remove();
  activeSelectionPopup?.listeners.abort();
  activeSelectionPopup = null;
}

function selectionWithinChatBubble(
  selection: Selection,
  threadRoot: HTMLElement,
): ChatSelectionSource | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const bubble = element?.closest<HTMLElement>(".chat-bubble");
  // A cross-message range has no single source message.
  if (!bubble || !threadRoot.contains(bubble)) {
    return null;
  }
  const text = selection.toString();
  if (!text.trim()) {
    return null;
  }
  const prefix = range.cloneRange();
  prefix.selectNodeContents(bubble);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return {
    text,
    start,
    end: prefix.toString().length,
    ...(bubble.dataset.messageId ? { messageId: bubble.dataset.messageId } : {}),
    ...(bubble.dataset.entryId ? { entryId: bubble.dataset.entryId } : {}),
  };
}

function positionPopup(popup: HTMLElement, anchor: DOMRect) {
  const viewport = window.visualViewport;
  const minLeft = (viewport?.offsetLeft ?? 0) + 8;
  const minTop = (viewport?.offsetTop ?? 0) + 8;
  const right = minLeft + (viewport?.width ?? window.innerWidth) - 16;
  const bottom = minTop + (viewport?.height ?? window.innerHeight) - 16;
  popup.style.maxWidth = `${right - minLeft}px`;
  popup.style.maxHeight = `${bottom - minTop}px`;
  const bounds = popup.getBoundingClientRect();
  const left = anchor.left + anchor.width / 2 - bounds.width / 2;
  const above = anchor.top - bounds.height - 8;
  const top = above >= minTop ? above : anchor.bottom + 8;
  popup.style.left = `${Math.max(minLeft, Math.min(left, right - bounds.width))}px`;
  popup.style.top = `${Math.max(minTop, Math.min(top, bottom - bounds.height))}px`;
}

function mountPopup(
  popup: HTMLDivElement,
  anchor: DOMRect,
  onEscape?: () => void,
  anchorElement?: HTMLElement,
) {
  removeChatSelectionPopup();
  document.body.appendChild(popup);
  const listeners = new AbortController();
  activeSelectionPopup = { element: popup, listeners };
  const { signal } = listeners;
  const position = () => positionPopup(popup, anchorElement?.getBoundingClientRect() ?? anchor);
  position();
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!popup.contains(event.target as Node | null)) {
        removeChatSelectionPopup();
      }
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
        event.preventDefault();
        event.stopPropagation();
        removeChatSelectionPopup();
        onEscape?.();
      }
    },
    { signal },
  );
  document.addEventListener(
    "scroll",
    (event) => {
      if (!(event.target instanceof Node) || !popup.contains(event.target)) {
        removeChatSelectionPopup();
      }
    },
    { capture: true, passive: true, signal },
  );
  window.addEventListener("resize", position, { signal });
  window.visualViewport?.addEventListener("resize", position, { signal });
  return signal;
}

function button(label: string, onActivate: () => void): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("aria-label", label);
  control.textContent = label;
  control.addEventListener("click", onActivate);
  return control;
}

function showChatSelectionPopup(
  anchor: DOMRect,
  selection: ChatSelectionSource,
  actions: ChatSelectionPopupActions,
) {
  const popup = document.createElement("div");
  popup.className = "chat-selection-popup";
  popup.setAttribute("role", "toolbar");
  popup.setAttribute("aria-label", t("chat.messages.selectionActions"));
  popup.addEventListener("pointerdown", (event) => event.preventDefault());
  const activate = (action: () => void) => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    action();
  };
  if (actions.onAddToChat) {
    const onAddToChat = actions.onAddToChat;
    popup.append(
      button(t("chat.messages.addToChat"), () => activate(() => onAddToChat(selection, anchor))),
    );
  }
  popup.append(
    button(t("chat.messages.askInSideChat"), () =>
      activate(() => actions.onAskSideChat(selection.text)),
    ),
  );
  const signal = mountPopup(popup, anchor);
  document.addEventListener(
    "selectionchange",
    () => {
      if (!window.getSelection() || window.getSelection()?.isCollapsed) {
        removeChatSelectionPopup();
      }
    },
    { signal },
  );
}

export function showChatAnnotationEditor(options: {
  anchorRect: DOMRect;
  anchorElement?: HTMLElement;
  sourceRange?: Range;
  comment: string;
  expanded?: boolean;
  readSignal?: AbortSignal;
  onSave: (comment: string) => boolean | void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  if (options.readSignal?.aborted) {
    return undefined;
  }
  const popup = document.createElement("div");
  popup.className = "exec-approval-card exec-approval-card--inline chat-annotation-editor";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", t("chat.messages.annotationEditor"));
  const input = document.createElement("textarea");
  input.className = "input";
  input.value = options.comment;
  input.rows = 1;
  input.placeholder = t("chat.messages.annotationComment");
  input.setAttribute("aria-label", t("chat.messages.annotationComment"));
  const cancel = () => {
    removeChatSelectionPopup();
    options.onCancel?.();
  };
  const save = () => {
    if (options.readSignal?.aborted) {
      removeChatSelectionPopup();
      return;
    }
    if (options.onSave(input.value) !== false) {
      removeChatSelectionPopup();
    }
  };
  const confirm = button(t("chat.messages.saveAnnotation"), save);
  confirm.className = "btn primary chat-annotation-editor__confirm";
  confirm.textContent = "";
  render(icons.cornerDownLeft, confirm);
  const controls = document.createElement("div");
  controls.className = "chat-annotation-editor__controls";
  const remove = button(t("chat.messages.deleteAnnotation"), () => {
    removeChatSelectionPopup();
    if (!options.readSignal?.aborted) {
      (options.onDelete ?? options.onCancel)?.();
    }
  });
  remove.className = "btn btn--icon btn--ghost chat-annotation-editor__delete";
  remove.title = t("chat.messages.deleteAnnotation");
  remove.textContent = "";
  render(icons.trash, remove);
  const cancelButton = button(t("common.cancel"), cancel);
  cancelButton.className = "btn";
  const saveButton = button(t("common.save"), save);
  saveButton.className = "btn primary";
  controls.append(remove, cancelButton, saveButton);
  popup.append(input, confirm, controls);
  if (options.expanded) {
    popup.classList.add("chat-annotation-editor--expanded");
    input.rows = 4;
  }
  popup.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      (!popup.classList.contains("chat-annotation-editor--expanded") ||
        event.metaKey ||
        event.ctrlKey)
    ) {
      event.preventDefault();
      save();
    }
    if (event.key === "Tab") {
      const focusable = [input, ...Array.from(popup.querySelectorAll("button"))].filter(
        (element) => element.getClientRects().length > 0,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  const signal = mountPopup(popup, options.anchorRect, options.onCancel, options.anchorElement);
  if (options.sourceRange && typeof Highlight !== "undefined") {
    // Keep the passage visible as a selection after focus moves into the textarea.
    CSS.highlights.set("openclaw-comment", new Highlight(options.sourceRange));
    signal.addEventListener("abort", () => CSS.highlights.delete("openclaw-comment"), {
      once: true,
    });
  }
  const abort = () => removeChatSelectionPopup();
  options.readSignal?.addEventListener("abort", abort, { once: true });
  signal.addEventListener("abort", () => options.readSignal?.removeEventListener("abort", abort), {
    once: true,
  });
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
  return () => {
    if (activeSelectionPopup?.element === popup) {
      positionPopup(popup, options.anchorElement?.getBoundingClientRect() ?? options.anchorRect);
    }
  };
}

export function handleChatSelectionPointerUp(
  event: PointerEvent,
  actions: ChatSelectionPopupActions,
) {
  const threadRoot = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!threadRoot) {
    return;
  }
  removeChatSelectionPopup();
  selectionPopupTimer = window.setTimeout(() => {
    selectionPopupTimer = null;
    const selection = window.getSelection();
    const source = selection ? selectionWithinChatBubble(selection, threadRoot) : null;
    if (source && selection && threadRoot.isConnected) {
      showChatSelectionPopup(selection.getRangeAt(0).getBoundingClientRect(), source, actions);
    }
  }, 0);
}
