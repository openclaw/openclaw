import { takeBootComposer } from "../../app/boot-composer.ts";
import {
  composerInputHasFocus,
  focusComposerInput,
  readComposerEditor,
  selectComposerInput,
} from "../../lib/composer-input.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { getChatComposerState, queueComposerSubmit } from "./components/chat-composer-state.ts";

/**
 * The linked session's pane continues what was typed while the page loaded,
 * after its first frame commits the real composer. A saved draft the boot frame
 * could not show stays first, and only text the operator saw when pressing
 * Enter may send by itself, through the composer's normal admission.
 */
export function adoptBootComposer(
  pane: Pick<ChatPaneRuntime, "ownsRouteComposer" | "state" | "presentationId" | "awaitDomCommit">,
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
  focusComposerInput(textarea, { preventScroll: true });
  // The draft owner publishes from this frame's commit; wait for its next DOM
  // commit before restoring selection. A merged saved draft has a different layout.
  const offset = draft.length - boot.text.length;
  const [start, end, direction] = boot.selection;
  void pane.awaitDomCommit().then(() => {
    if (textarea.value === draft && composerInputHasFocus(textarea)) {
      selectComposerInput(textarea, start + offset, end + offset, direction);
      if (!saved) {
        const scroll = readComposerEditor(textarea)?.scrollElement ?? textarea;
        [scroll.scrollLeft, scroll.scrollTop] = boot.scroll;
      }
    }
  });
}
