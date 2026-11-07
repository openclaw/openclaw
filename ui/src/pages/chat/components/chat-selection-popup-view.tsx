import { Portal, render } from "@solidjs/web";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../../lib/keyboard-shortcut-contract.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  type ChatSelectionPopupActions,
  registerChatSelectionPopup,
  removeChatSelectionPopup,
} from "./chat-selection-popup.tsx";

registerChatMessageMetadataEnglish();

export function showChatSelectionToolbar(
  threadRoot: HTMLElement,
  range: Range,
  text: string,
  actions: ChatSelectionPopupActions,
) {
  const container = range.commonAncestorContainer;
  const selectionElement = container instanceof Element ? container : container.parentElement;
  const bubble = selectionElement?.closest<HTMLElement>(".chat-bubble");
  // A cross-message range has no single source message.
  if (!bubble || !threadRoot.contains(bubble)) {
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
  const anchor = range.getBoundingClientRect();
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
          {/* Hover or focus expands the destinations to the right, keeping the label
              under the pointer; touch shows them expanded. */}
          <div class="chat-selection-popup__ask" role="group" aria-label={t("chat.messages.askIn")}>
            <span class="chat-selection-popup__ask-label" aria-hidden="true">
              {t("chat.messages.askIn")}
              <Icon name="chevronRight" />
            </span>
            <span class="chat-selection-popup__ask-options">
              <span>
                <button
                  type="button"
                  aria-label={t("chat.messages.askInSideChat")}
                  onClick={() => activate(() => actions.onAskSideChat(source, anchor))}
                >
                  {t("chat.messages.sideChatOption")}
                </button>
                <button
                  type="button"
                  aria-label={t("chat.messages.askInNewSession")}
                  onClick={() => activate(() => actions.onAskNewSession(source))}
                >
                  {t("chat.messages.newSessionOption")}
                </button>
              </span>
            </span>
          </div>
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
  // Expanding the destinations grows the toolbar rightward; slide left only
  // by the overflow so the hovered label stays under the pointer.
  const resize = new ResizeObserver(() => keepChatSelectionPopupInView(popup));
  resize.observe(popup);
  signal.addEventListener("abort", () => resize.disconnect());
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

function keepChatSelectionPopupInView(popup: HTMLElement) {
  const viewport = window.visualViewport;
  const minLeft = (viewport?.offsetLeft ?? 0) + 8;
  const right = minLeft - 8 + (viewport?.width ?? window.innerWidth) - 16;
  const bounds = popup.getBoundingClientRect();
  if (bounds.right > right) {
    popup.style.left = `${Math.max(minLeft, right - bounds.width)}px`;
  }
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
  const signal = registerChatSelectionPopup(popup, paneId, dispose);
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
