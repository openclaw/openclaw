import { createStore } from "solid-js";
import { focusComposerInput, readComposerEditor } from "../composer-input.ts";
import { t } from "../reactive/i18n.ts";
import { listen } from "../reactive/listener.ts";

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
  /** Synchronous phase; the reactive card is presentation and commits later. */
  phase: ComposerTaskCard["kind"];
  cancel: AbortController;
  resolve: ((outcome: ComposerProposalOutcome) => void) | null;
};

/**
 * The pane's composer task: work a plugin action runs for the draft, shown in one card that
 * changes in place from working to a proposal or a failure. A proposal is presentation until
 * the user accepts it; accepting replaces the draft as one editor history step, so undo
 * restores the previous draft with its mentions.
 */
export function createComposerTasks(pane: {
  /** Mounted built-in composers; a replacement composer mounts none and so cannot run tasks. */
  readonly taskPresenters: number;
  readonly composerComposing: boolean;
  readonly composerTextarea: HTMLTextAreaElement | null;
  /** The mounted composer's send, as Enter; null without a built-in composer. */
  readonly sendDraft: (() => boolean) | null;
}) {
  const presented = () => pane.taskPresenters > 0;
  const [state, setState] = createStore<{
    card: ComposerTaskCard | null;
    /** The one-row receipt after Use; it lasts until the draft changes, a send, or dismissal. */
    accepted: { title: string } | null;
  }>({ card: null, accepted: null });
  let current: Current | null = null;
  let nextId = 0;
  // The text Use wrote: the receipt retires on the first draft that differs from it.
  let written = "";

  /** Ends the current task: a proposal resolves `outcome`; unfinished work is aborted. */
  function settle(outcome: ComposerProposalOutcome = "dismissed") {
    const ending = current;
    current = null;
    setState((draft) => {
      draft.card = null;
    });
    ending?.resolve?.(outcome);
    if (ending?.phase === "working") {
      ending.cancel.abort();
    }
  }

  function start(options: {
    title: string;
    startedAt?: number;
    signal: AbortSignal;
    actionKey?: string;
    retry?: () => void;
  }) {
    options.signal.throwIfAborted();
    if (!presented()) {
      throw new Error(t("chat.composer.proposal.unavailable"));
    }
    settle();
    const id = ++nextId;
    const cancel = new AbortController();
    current = { id, phase: "working", cancel, resolve: null };
    const live = () => current?.id === id;
    const signal = AbortSignal.any([options.signal, cancel.signal]);
    // The action retiring (chat switch, pane change, plugin reload) or Cancel ends the card.
    listen(signal, "abort", () => live() && settle(), { once: true });
    setState((draft) => {
      draft.card = {
        kind: "working",
        title: options.title,
        startedAt: options.startedAt ?? Date.now(),
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
      propose(
        text: string,
        proposal: { title: string; insert?: boolean; send?: boolean },
      ): Promise<ComposerProposalOutcome> {
        if (!live()) {
          return Promise.resolve("dismissed");
        }
        const { promise, resolve } = Promise.withResolvers<ComposerProposalOutcome>();
        current!.resolve = resolve;
        current!.phase = "proposal";
        // Mid-composition the proposal waits for Use, like a locked editor.
        const target =
          (proposal.insert || proposal.send) && !pane.composerComposing
            ? pane.composerTextarea
            : null;
        // A locked or composing editor keeps the proposal, so Use writes it once writable.
        if (target && writable(target)) {
          apply(target, text, proposal.title);
          if (proposal.send) {
            pane.sendDraft?.();
          }
        } else {
          setState((draft) => {
            draft.card = { kind: "proposal", title: proposal.title, text };
          });
        }
        return promise;
      },
      fail(message: string): boolean {
        if (!live()) {
          return false;
        }
        current!.phase = "failed";
        setState((draft) => {
          draft.card = {
            kind: "failed",
            title: options.title,
            message,
            retry: options.retry ?? null,
          };
        });
        return true;
      },
    };
  }

  function writable(target: HTMLTextAreaElement) {
    // Dictation and pending goals lock the editor; the proposal waits until it is writable.
    return !target.readOnly && !target.disabled;
  }

  function apply(target: HTMLTextAreaElement, text: string, title: string) {
    settle("accepted");
    replaceDraft(target, text);
    written = text;
    // After the replacement's own input event, which retires an older receipt.
    setState((draft) => {
      draft.accepted = { title };
    });
  }

  function accept(target: HTMLTextAreaElement | null) {
    const card = state.card;
    if (!target || !writable(target) || card?.kind !== "proposal") {
      return false;
    }
    apply(target, card.text, card.title);
    return true;
  }

  function undo(target: HTMLTextAreaElement | null) {
    // Like accept, a locked editor keeps the receipt until it is writable again.
    if (!target || target.readOnly || target.disabled || !state.accepted) {
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
    /** For the composer's live region, beside the prediction announcement. */
    get announcement() {
      const card = state.card;
      if (card?.kind === "working") {
        return t("chat.composer.task.working", { title: card.title });
      }
      if (card?.kind === "proposal") {
        return t("chat.composer.proposal.available", { title: card.title });
      }
      return card?.kind === "failed" ? t("chat.composer.task.failed", { title: card.title }) : "";
    },
    get card() {
      return state.card;
    },
    get accepted() {
      return state.accepted;
    },
    start,
    /** A proposal without a working phase. */
    offer(
      text: string,
      proposal: { title: string; insert?: boolean; send?: boolean },
      signal: AbortSignal,
    ) {
      return start({ title: proposal.title, signal }).propose(text, proposal);
    },
    accept,
    /** Dismiss a proposal or failure, or cancel working, and retire the receipt. */
    dismiss: () => {
      settle();
      clearAccepted();
    },
    cancel: () => settle(),
    /** Show a failure that has no task of its own, such as a toolbar action that threw. */
    report(title: string, message: string): boolean {
      // Never take over a live card (another task) or an Undo receipt (a draft already replaced).
      if (!presented() || current || state.accepted) {
        return false;
      }
      setState((draft) => {
        draft.card = { kind: "failed", title, message, retry: null };
      });
      return true;
    },
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
