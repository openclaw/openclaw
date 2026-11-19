import { createStore } from "solid-js";
import { focusComposerInput, readComposerEditor } from "../../../lib/composer-input.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export type ComposerProposalOutcome = "accepted" | "dismissed";
export type ComposerTaskStep = { label: string; state: "running" | "done" | "failed" };

/** What the pane's task card shows; at most one per pane. */
export type ComposerTaskCard =
  | {
      kind: "working";
      title: string;
      startedAt: number;
      steps: readonly ComposerTaskStep[];
      summary: string | null;
      /** The composer action running it, shown pressed; a click cancels. */
      actionKey: string | null;
    }
  | { kind: "proposal"; title: string; text: string }
  | { kind: "failed"; title: string; message: string; retry: (() => void) | null };

type Current = {
  id: number;
  cancel: AbortController;
  resolve: ((outcome: ComposerProposalOutcome) => void) | null;
};

/**
 * The pane's composer task: work a plugin action runs for the draft, shown in one card that
 * changes in place from working to a proposal or a failure. A proposal is presentation until
 * the user accepts it; accepting replaces the draft as one editor history step, so undo
 * restores the previous draft with its mentions.
 */
export function createComposerTasks() {
  const [state, setState] = createStore<{
    card: ComposerTaskCard | null;
    /** The one-row receipt after Use; it lasts until the draft changes, a send, or dismissal. */
    accepted: { title: string } | null;
  }>({ card: null, accepted: null });
  let current: Current | null = null;
  let nextId = 0;
  // The text Use wrote: the receipt retires on the first draft that differs from it.
  let written = "";
  // Mounted task cards; a replacement composer mounts none and so cannot run tasks.
  let presenters = 0;

  /** Ends the current task: a proposal resolves `outcome`; unfinished work is aborted. */
  function settle(outcome: ComposerProposalOutcome = "dismissed") {
    const ending = current;
    const working = state.card?.kind === "working";
    current = null;
    setState((draft) => {
      draft.card = null;
    });
    ending?.resolve?.(outcome);
    if (working) {
      ending?.cancel.abort();
    }
  }

  function start(options: {
    title: string;
    signal: AbortSignal;
    actionKey?: string;
    retry?: () => void;
  }) {
    options.signal.throwIfAborted();
    if (presenters === 0) {
      throw new Error(t("chat.composer.proposal.unavailable"));
    }
    settle();
    const id = ++nextId;
    const cancel = new AbortController();
    current = { id, cancel, resolve: null };
    const live = () => current?.id === id;
    const signal = AbortSignal.any([options.signal, cancel.signal]);
    // The action retiring (chat switch, pane change, plugin reload) or Cancel ends the card.
    listen(signal, "abort", () => live() && settle(), { once: true });
    setState((draft) => {
      draft.card = {
        kind: "working",
        title: options.title,
        startedAt: Date.now(),
        steps: [],
        summary: null,
        actionKey: options.actionKey ?? null,
      };
      draft.accepted = null;
    });
    return {
      signal,
      update(progress: { steps?: readonly ComposerTaskStep[]; summary?: string }) {
        if (!live()) {
          return;
        }
        setState((draft) => {
          if (draft.card?.kind === "working") {
            if (progress.steps) {
              draft.card.steps = progress.steps.map((step) => ({
                label: step.label,
                state: step.state,
              }));
            }
            if (progress.summary !== undefined) {
              draft.card.summary = progress.summary || null;
            }
          }
        });
      },
      propose(text: string, proposal: { title: string }): Promise<ComposerProposalOutcome> {
        if (!live()) {
          return Promise.resolve("dismissed");
        }
        const { promise, resolve } = Promise.withResolvers<ComposerProposalOutcome>();
        current!.resolve = resolve;
        setState((draft) => {
          draft.card = { kind: "proposal", title: proposal.title, text };
        });
        return promise;
      },
      fail(message: string) {
        if (!live()) {
          return;
        }
        setState((draft) => {
          draft.card = {
            kind: "failed",
            title: options.title,
            message,
            retry: options.retry ?? null,
          };
        });
      },
    };
  }

  function accept(target: HTMLTextAreaElement | null) {
    const card = state.card;
    if (!target || card?.kind !== "proposal") {
      return false;
    }
    settle("accepted");
    replaceDraft(target, card.text);
    written = card.text;
    // After the replacement's own input event, which retires an older receipt.
    setState((draft) => {
      draft.accepted = { title: card.title };
    });
    return true;
  }

  function undo(target: HTMLTextAreaElement | null) {
    if (!target || !state.accepted) {
      return;
    }
    clearAccepted();
    focusComposerInput(target, { preventScroll: true });
    const editor = readComposerEditor(target);
    if (editor) {
      editor.undo();
    } else {
      target.ownerDocument.execCommand?.("undo");
    }
  }

  function clearAccepted() {
    if (state.accepted) {
      setState((draft) => {
        draft.accepted = null;
      });
    }
  }

  return {
    /** Called by a mounted task card; returns its release. */
    present() {
      presenters += 1;
      return () => {
        presenters -= 1;
        if (presenters === 0) {
          settle();
        }
      };
    },
    get card() {
      return state.card;
    },
    get accepted() {
      return state.accepted;
    },
    start,
    /** A proposal without a working phase. */
    offer(text: string, title: string, signal: AbortSignal) {
      return start({ title, signal }).propose(text, { title });
    },
    accept,
    /** Dismiss a proposal or failure, or cancel working, and retire the receipt. */
    dismiss: () => {
      settle();
      clearAccepted();
    },
    cancel: () => settle(),
    retry() {
      const card = state.card;
      if (card?.kind === "failed" && card.retry) {
        const retry = card.retry;
        settle();
        retry();
      }
    },
    undo,
    clearAccepted,
    /**
     * Every draft change reaches here, including writes that bypass the textarea (an attachment
     * restoring its text, another action's setDraft). The first one that is not the accepted
     * text retires the receipt for good, so Undo never steps over newer text.
     */
    syncDraft(draft: string) {
      if (state.accepted && draft !== written) {
        clearAccepted();
      }
    },
  };
}

/** One isolated edit over the whole draft, so a single undo step reverts it. */
function replaceDraft(target: HTMLTextAreaElement, text: string) {
  focusComposerInput(target, { preventScroll: true });
  const editor = readComposerEditor(target);
  if (editor) {
    editor.replaceAll(text);
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

export type ComposerTasks = ReturnType<typeof createComposerTasks>;
