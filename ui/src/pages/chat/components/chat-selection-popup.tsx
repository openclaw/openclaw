// Document-owned selection toolbar and annotation editor. The transcript owner
// tears both down together when its session or presentation changes.
import { lazyModule } from "solid-js";
import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../../lib/keyboard-shortcut-contract.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export type ChatSelectionPopupActions = {
  paneId: string;
  onAddToChat?: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
  onAskSideChat: (selection: ChatSelectionSource, anchorRect: DOMRect) => void;
  onAskNewSession: (selection: ChatSelectionSource) => void;
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
const selectionToolbar = lazyModule(() => import("./chat-selection-popup-view.tsx"));

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

export function registerChatSelectionPopup(
  popup: HTMLDivElement,
  paneId: string,
  dispose: () => void,
): AbortSignal {
  const listeners = new AbortController();
  activeSelectionPopup = { element: popup, listeners, paneId, dispose };
  return listeners.signal;
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
  const pending: NonNullable<typeof selectionPopupTimer> = {
    paneId: actions.paneId,
    timer: window.setTimeout(() => {
      selectionPopupTimer = null;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (!threadRoot.contains(range.commonAncestorContainer)) {
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        return;
      }
      if (!threadRoot.isConnected) {
        return;
      }
      removeChatSelectionPopup();
      selectionPopupTimer = pending;
      void selectionToolbar()
        .then(({ showChatSelectionToolbar }) => {
          if (selectionPopupTimer !== pending) {
            return;
          }
          selectionPopupTimer = null;
          const current = window.getSelection();
          if (
            threadRoot.isConnected &&
            current?.rangeCount === 1 &&
            current.getRangeAt(0) === range &&
            current.toString() === text
          ) {
            showChatSelectionToolbar(threadRoot, range, text, actions);
          }
        })
        .catch((error: unknown) => {
          if (selectionPopupTimer === pending) {
            selectionPopupTimer = null;
            reportError(error);
          }
        });
    }, 0),
  };
  selectionPopupTimer = pending;
}

export function isChatSelectionPopupElement(element: HTMLElement): boolean {
  return activeSelectionPopup?.element === element;
}
