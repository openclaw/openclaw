import { createStore } from "solid-js";
import { focusComposerInput, readComposerEditor } from "../../../lib/composer-input.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export type ComposerProposalOutcome = "accepted" | "dismissed";

type Pending = { text: string; title: string; resolve: (outcome: ComposerProposalOutcome) => void };

/**
 * A draft a plugin offers beside the composer. It is presentation until the user accepts it;
 * accepting replaces the draft as one native edit, so the editor's undo restores the old draft.
 */
export function createComposerProposal() {
  const [state, setState] = createStore<{
    pending: { text: string; title: string } | null;
    /** The one-row receipt after Use; it lasts until the next edit, send, or dismissal. */
    accepted: { title: string } | null;
  }>({ pending: null, accepted: null });
  let pending: Pending | null = null;
  // The draft Use replaced, for the receipt's Undo.
  let replaced = "";
  // Mounted proposal cards; a replacement composer mounts none and so cannot be offered drafts.
  let presenters = 0;

  function settle(outcome: ComposerProposalOutcome) {
    const current = pending;
    pending = null;
    setState((draft) => {
      draft.pending = null;
    });
    current?.resolve(outcome);
    return current;
  }

  function offer(
    text: string,
    title: string,
    signal: AbortSignal,
  ): Promise<ComposerProposalOutcome> {
    signal.throwIfAborted();
    if (presenters === 0) {
      return Promise.reject(new Error(t("chat.composer.proposal.unavailable")));
    }
    settle("dismissed");
    const { promise, resolve } = Promise.withResolvers<ComposerProposalOutcome>();
    const entry: Pending = { text, title, resolve };
    pending = entry;
    setState((draft) => {
      draft.pending = { text, title };
      draft.accepted = null;
    });
    // The offering action retiring (chat switch, pane change, plugin reload) withdraws it.
    listen(signal, "abort", () => pending === entry && settle("dismissed"), { once: true });
    return promise;
  }

  function accept(target: HTMLTextAreaElement | null) {
    if (!target || !pending) {
      return false;
    }
    const entry = settle("accepted");
    if (!entry) {
      return false;
    }
    const previous = target.value;
    replaceDraft(target, entry.text);
    // After the insertion's own input event, which clears an older receipt.
    setState((draft) => {
      draft.accepted = { title: entry.title };
    });
    replaced = previous;
    return true;
  }

  function undo(target: HTMLTextAreaElement | null) {
    if (!target || !state.accepted) {
      return;
    }
    // The receipt only exists while the accepted text is unedited, so this restores exactly
    // what Use replaced, through the same path as the replacement.
    replaceDraft(target, replaced);
    clearAccepted();
  }

  function clearAccepted() {
    if (state.accepted) {
      setState((draft) => {
        draft.accepted = null;
      });
    }
  }

  return {
    /** Called by a mounted proposal card; returns its release. */
    present() {
      presenters += 1;
      return () => {
        presenters -= 1;
        if (presenters === 0) {
          settle("dismissed");
        }
      };
    },
    get pending() {
      return state.pending;
    },
    get accepted() {
      return state.accepted;
    },
    offer,
    accept,
    dismiss: () => {
      settle("dismissed");
      clearAccepted();
    },
    undo,
    clearAccepted,
  };
}

/** One native edit over the whole draft, as with predictions, so ⌘Z steps over it. */
function replaceDraft(target: HTMLTextAreaElement, text: string) {
  focusComposerInput(target, { preventScroll: true });
  const editor = readComposerEditor(target);
  if (editor) {
    editor.replace(text, 0, target.value.length);
    return;
  }
  target.setSelectionRange(0, target.value.length);
  if (!target.ownerDocument.execCommand?.("insertText", false, text)) {
    target.setRangeText(text, 0, target.value.length, "end");
    target.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
  }
}

export type ComposerProposal = ReturnType<typeof createComposerProposal>;
