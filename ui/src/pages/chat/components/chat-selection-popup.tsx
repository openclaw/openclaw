// Document-owned selection toolbar and annotation editor. The transcript owner
// tears both down together when its session or presentation changes.
import { Portal, render } from "@solidjs/web";
import { lazyModule } from "solid-js";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
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
let pendingEditor: { paneId: string; listeners: AbortController } | null = null;
const annotationEditor = lazyModule(() => import("./chat-annotation-editor.tsx"));

/** A dismissed or replaced selection must not reopen when its editor import settles. */
export async function showChatAnnotationEditor(
  options: Parameters<
    (typeof import("./chat-annotation-editor.tsx"))["showChatAnnotationEditor"]
  >[0],
  current: () => boolean,
) {
  if (options.readSignal?.aborted || !current()) {
    return undefined;
  }
  removeChatSelectionPopup();
  const pending = { paneId: options.paneId, listeners: new AbortController() };
  pendingEditor = pending;
  const signal = pending.listeners.signal;
  if (options.readSignal) {
    listen(
      options.readSignal,
      "abort",
      () => {
        if (pendingEditor === pending) {
          removeChatSelectionPopup();
        }
      },
      { signal, once: true },
    );
  }
  listen(document, "pointerdown", () => removeChatSelectionPopup(), { capture: true, signal });
  listen(document, "scroll", () => removeChatSelectionPopup(), {
    capture: true,
    passive: true,
    signal,
  });
  listen(
    document,
    "keydown",
    (event) => {
      if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
        event.preventDefault();
        event.stopPropagation();
        removeChatSelectionPopup();
        options.onCancel?.();
      }
    },
    { signal },
  );
  let renderEditor: (typeof import("./chat-annotation-editor.tsx"))["showChatAnnotationEditor"];
  try {
    ({ showChatAnnotationEditor: renderEditor } = await annotationEditor());
  } catch (error) {
    const report = pendingEditor === pending && !options.readSignal?.aborted && current();
    if (pendingEditor === pending) {
      pendingEditor = null;
    }
    pending.listeners.abort();
    if (report) {
      throw error;
    }
    return undefined;
  }
  if (pendingEditor !== pending || options.readSignal?.aborted || !current()) {
    if (pendingEditor === pending) {
      pendingEditor = null;
    }
    pending.listeners.abort();
    return undefined;
  }
  pendingEditor = null;
  pending.listeners.abort();
  return renderEditor(options);
}

export function removeChatSelectionPopup(paneId?: string) {
  if (paneId === undefined || pendingEditor?.paneId === paneId) {
    pendingEditor?.listeners.abort();
    pendingEditor = null;
  }
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

export function positionChatSelectionPopup(popup: HTMLElement, anchor: DOMRect) {
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

export function mountChatSelectionPopup(
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
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return;
      }
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const selectionElement = container instanceof Element ? container : container.parentElement;
      const bubble = selectionElement?.closest<HTMLElement>(".chat-bubble");
      // A cross-message range has no single source message.
      if (!bubble || !threadRoot.contains(bubble)) {
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        return;
      }
      const prefix = range.cloneRange();
      prefix.selectNodeContents(bubble);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset);
      const source: ChatSelectionSource = {
        text,
        start,
        end: prefix.toString().length,
        ...(bubble.dataset.messageId ? { messageId: bubble.dataset.messageId } : {}),
        ...(bubble.dataset.entryId ? { entryId: bubble.dataset.entryId } : {}),
      };
      if (!threadRoot.isConnected) {
        return;
      }
      const anchor = selection.getRangeAt(0).getBoundingClientRect();
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
              onPointerDown={(pointerEvent) => pointerEvent.preventDefault()}
            >
              {actions.onAddToChat ? (
                <button
                  type="button"
                  aria-label={t("chat.messages.addToChat")}
                  onClick={() => activate(() => actions.onAddToChat?.(source, anchor))}
                >
                  {t("chat.messages.addToChat")}
                </button>
              ) : undefined}
              <button
                type="button"
                aria-label={t("chat.messages.askInSideChat")}
                onClick={() => activate(() => actions.onAskSideChat(source, anchor))}
              >
                {t("chat.messages.askInSideChat")}
              </button>
            </div>
          </Portal>
        ),
        document.createElement("div"),
      );
      const signal = mountChatSelectionPopup(
        popup,
        () => positionChatSelectionPopup(popup, anchor),
        actions.paneId,
        dispose,
      );
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
    }, 0),
  };
}

export function isChatSelectionPopupElement(element: HTMLElement): boolean {
  return activeSelectionPopup?.element === element;
}
