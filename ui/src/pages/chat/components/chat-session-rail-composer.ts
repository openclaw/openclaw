import type { ChatSendShortcut } from "../../../app/settings.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";

export function createSessionRailComposer(options: {
  submit: () => void;
  onDraftChange: (draft: string) => void;
  sendShortcut: () => ChatSendShortcut;
}) {
  let textarea: HTMLTextAreaElement | null = null;
  const ref = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (textarea && textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(textarea);
    }
    textarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
    }
  };
  return {
    ref,
    dispose() {
      ref();
    },
    syncDraft(draft: string) {
      if (textarea?.isConnected && textarea.value !== draft) {
        scheduleTextareaHeightAdjustment(textarea);
      }
    },
    handleKeydown: (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const sendShortcutMatches =
        options.sendShortcut() === "enter" || event.metaKey || event.ctrlKey;
      if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
        event.preventDefault();
        if (!event.repeat) {
          options.submit();
        }
      }
    },
    handleInput: (event: InputEvent) => {
      const target = event.currentTarget;
      if (target instanceof HTMLTextAreaElement) {
        adjustTextareaHeight(target);
        options.onDraftChange(target.value);
      }
    },
  };
}
