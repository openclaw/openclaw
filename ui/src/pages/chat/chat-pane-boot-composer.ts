import { onSettled } from "solid-js";
import { takeBootComposer } from "../../app/boot-composer.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { getChatComposerState, queueComposerSubmit } from "./components/chat-composer-state.ts";

/**
 * The linked session's pane continues what was typed while the page loaded,
 * after its first frame commits the real composer. A saved draft the boot frame
 * could not show stays first, and only text the operator saw when pressing
 * Enter may send by itself, through the composer's normal admission.
 */
export function adoptBootComposer(
  pane: Pick<ChatPaneRuntime, "ownsRouteComposer" | "state" | "presentationId">,
): void {
  const state = pane.state;
  const boot = pane.ownsRouteComposer && state ? takeBootComposer() : null;
  if (!state || !boot) {
    return;
  }
  const composer = getChatComposerState(pane.presentationId);
  const saved = state.chatMessage.trim() ? state.chatMessage : "";
  const draft = saved ? `${saved}\n${boot.text}` : boot.text;
  if (boot.text) {
    state.handleChatDraftChange(draft, saved ? (state.chatMentions ?? []) : []);
    if (boot.submit && !saved) {
      queueComposerSubmit(composer, draft);
    }
  }
  if (!boot.focused) {
    return;
  }
  const textarea = composer.composerTextarea;
  if (!textarea?.isConnected) {
    // A composer that attaches later takes focus through its own ref.
    composer.restoreComposerFocus = true;
    return;
  }
  textarea.focus({ preventScroll: true });
  // Restore the caret and its viewport after the draft and mobile editing layout
  // commit, before paint. A merged saved draft has a different text layout.
  const offset = draft.length - boot.text.length;
  const [start, end, direction] = boot.selection;
  onSettled(() => {
    if (textarea.value === draft && document.activeElement === textarea) {
      textarea.setSelectionRange(start + offset, end + offset, direction);
      if (!saved) {
        [textarea.scrollLeft, textarea.scrollTop] = boot.scroll;
      }
    }
  });
}
