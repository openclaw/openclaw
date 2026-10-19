// Document-owned selection toolbar and annotation editor. The transcript owner
// tears both down together when its session or presentation changes.
import { Portal, render } from "@solidjs/web";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../../lib/keyboard-shortcut-contract.ts";
import { listen } from "../../../lib/reactive/listener.ts";

registerChatMessageMetadataEnglish();

type ChatSelectionPopupActions = {
  paneId: string;
  onAddToChat?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
  onAskSideChat: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
};

let activeSelectionPopup: {
  element: HTMLDivElement;
  listeners: AbortController;
  paneId: string;
  dispose: () => void;
} | null = null;
let selectionPopupTimer: { timer: number; paneId: string } | null = null;

export function removeChatSelectionPopup(paneId?: string) {
  if (selectionPopupTimer && (paneId === undefined || selectionPopupTimer.paneId === paneId)) {
    window.clearTimeout(selectionPopupTimer.timer);
    selectionPopupTimer = null;
  }
  if (paneId !== undefined && activeSelectionPopup?.paneId !== paneId) {
    return;
  }
  const popup = activeSelectionPopup;
  activeSelectionPopup = null;
  popup?.listeners.abort();
  popup?.dispose();
}

export function isChatSelectionPopupFocused(paneId: string): boolean {
  return (
    activeSelectionPopup?.paneId === paneId &&
    activeSelectionPopup.element.contains(document.activeElement)
  );
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
  const below = anchor.bottom + 8;
  const growDown =
    popup.classList.contains("chat-annotation-editor") && below + bounds.height <= bottom;
  const top = growDown || above < minTop ? below : above;
  popup.style.left = `${Math.max(minLeft, Math.min(left, right - bounds.width))}px`;
  popup.style.top = `${Math.max(minTop, Math.min(top, bottom - bounds.height))}px`;
}

function mountPopup(
  popup: HTMLDivElement,
  layout: () => void,
  paneId: string,
  dispose: () => void,
  onEscape?: () => void,
  // A layout-driven transcript scroll must not dismiss in-progress input. The
  // annotation editor supplies its own policy; the selection toolbar keeps the
  // default scroll dismissal.
  shouldDismissOnScroll: () => boolean = () => true,
) {
  const listeners = new AbortController();
  activeSelectionPopup = { element: popup, listeners, paneId, dispose };
  const { signal } = listeners;
  layout();
  listen(
    document,
    "pointerdown",
    (event) => {
      if (!(event.target instanceof Node) || !popup.contains(event.target)) {
        removeChatSelectionPopup();
      }
    },
    { capture: true, signal },
  );
  listen(
    document,
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
  listen(
    document,
    "scroll",
    (event) => {
      if (!(event.target instanceof Node) || !popup.contains(event.target)) {
        if (shouldDismissOnScroll()) {
          removeChatSelectionPopup();
        }
      }
    },
    { capture: true, passive: true, signal },
  );
  listen(window, "resize", layout, { signal });
  if (window.visualViewport) {
    listen(window.visualViewport, "resize", layout, { signal });
  }
  return signal;
}

function showChatSelectionPopup(
  anchor: DOMRect,
  selection: ChatSelectionSource,
  actions: ChatSelectionPopupActions,
) {
  removeChatSelectionPopup();
  let popup!: HTMLDivElement;
  const activate = (action: () => void) => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    action();
  };
  const dispose = render(
    () => (
      <Portal mount={document.body}>
        <div
          ref={(element) => {
            popup = element;
          }}
          class="chat-selection-popup"
          role="toolbar"
          aria-label={t("chat.messages.selectionActions")}
          onPointerDown={(event) => event.preventDefault()}
        >
          {actions.onAddToChat ? (
            <button
              type="button"
              aria-label={t("chat.messages.addToChat")}
              onClick={() => activate(() => actions.onAddToChat?.(selection, anchor))}
            >
              {t("chat.messages.addToChat")}
            </button>
          ) : undefined}
          <button
            type="button"
            aria-label={t("chat.messages.askInSideChat")}
            onClick={() => activate(() => actions.onAskSideChat(selection, anchor))}
          >
            {t("chat.messages.askInSideChat")}
          </button>
        </div>
      </Portal>
    ),
    document.createElement("div"),
  );
  const signal = mountPopup(popup, () => positionPopup(popup, anchor), actions.paneId, dispose);
  listen(
    document,
    "selectionchange",
    () => {
      const currentSelection = window.getSelection();
      if (!currentSelection || currentSelection.isCollapsed) {
        removeChatSelectionPopup();
      }
    },
    { signal },
  );
}

export function showChatAnnotationEditor(options: {
  paneId: string;
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
  removeChatSelectionPopup();
  let popup!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  let confirm!: HTMLButtonElement;
  let remove!: HTMLButtonElement;
  let cancelButton!: HTMLButtonElement;
  let saveButton!: HTMLButtonElement;
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
  const resizeInput = () => {
    const scrollTop = input.scrollTop;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    input.scrollTop = scrollTop;
    positionPopup(popup, options.anchorElement?.getBoundingClientRect() ?? options.anchorRect);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target === input &&
      !isComposingKeyboardEvent(event) &&
      (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sendMessage, event) ||
        matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event))
    ) {
      event.preventDefault();
      save();
    }
    if (event.key === "Tab") {
      const focusable = [input, confirm, remove, cancelButton, saveButton].filter(
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
  };
  const dispose = render(
    () => (
      <Portal mount={document.body}>
        <div
          ref={(element) => {
            popup = element;
          }}
          class={[
            "chat-annotation-editor",
            { "chat-annotation-editor--expanded": options.expanded },
          ]}
          role="dialog"
          aria-label={t("chat.messages.annotationEditor")}
          onKeyDown={onKeyDown}
        >
          <textarea
            ref={(element) => {
              input = element;
            }}
            value={options.comment}
            rows={1}
            placeholder={t("chat.messages.annotationComment")}
            aria-label={t("chat.messages.annotationComment")}
            onInput={resizeInput}
            onCompositionEnd={recordCompositionEnd}
            onKeyUp={clearCompositionEnd}
            onBlur={clearCompositionEnd}
          />
          <button
            ref={(element) => {
              confirm = element;
            }}
            type="button"
            class="btn primary chat-annotation-editor__confirm"
            aria-label={t("chat.messages.saveAnnotation")}
            onClick={save}
          >
            <Icon name="cornerDownLeft" />
          </button>
          <div class="chat-annotation-editor__controls">
            <button
              ref={(element) => {
                remove = element;
              }}
              type="button"
              class="btn btn--icon btn--ghost chat-annotation-editor__delete"
              aria-label={t("chat.messages.deleteAnnotation")}
              title={t("chat.messages.deleteAnnotation")}
              onClick={() => {
                removeChatSelectionPopup();
                if (!options.readSignal?.aborted) {
                  (options.onDelete ?? options.onCancel)?.();
                }
              }}
            >
              <Icon name="trash" />
            </button>
            <button
              ref={(element) => {
                cancelButton = element;
              }}
              type="button"
              class="btn"
              aria-label={t("common.cancel")}
              onClick={cancel}
            >
              {t("common.cancel")}
            </button>
            <button
              ref={(element) => {
                saveButton = element;
              }}
              type="button"
              class="btn primary"
              aria-label={t("common.save")}
              onClick={save}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </Portal>
    ),
    document.createElement("div"),
  );
  // A width or height change repositions the editor and makes the transcript
  // follow its end by scrolling. That layout compensation must not discard a
  // comment the user is still writing, so an edited comment survives the
  // scroll; an untouched editor still closes, keeping its existing behavior.
  const originalComment = options.comment;
  const signal = mountPopup(
    popup,
    resizeInput,
    options.paneId,
    dispose,
    options.onCancel,
    () => input.value === originalComment,
  );
  if (options.sourceRange && typeof Highlight !== "undefined") {
    // Keep the passage visible as a selection after focus moves into the textarea.
    CSS.highlights.set("openclaw-comment", new Highlight(options.sourceRange));
    listen(signal, "abort", () => CSS.highlights.delete("openclaw-comment"), {
      once: true,
    });
  }
  const abort = () => removeChatSelectionPopup();
  if (options.readSignal) {
    const stopRead = listen(options.readSignal, "abort", abort, { once: true });
    listen(signal, "abort", stopRead, { once: true });
  }
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
  selectionPopupTimer = {
    paneId: actions.paneId,
    timer: window.setTimeout(() => {
      selectionPopupTimer = null;
      const selection = window.getSelection();
      const source = selection ? selectionWithinChatBubble(selection, threadRoot) : null;
      if (source && selection && threadRoot.isConnected) {
        showChatSelectionPopup(selection.getRangeAt(0).getBoundingClientRect(), source, actions);
      }
    }, 0),
  };
}
