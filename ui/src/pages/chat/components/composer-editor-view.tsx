import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { ApplicationContext } from "../../../app/context-types.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import {
  HUMAN_MENTION_CLIPBOARD_TYPE,
  readHumanMentionClipboard,
  prepareHumanMentionPaste,
} from "../../../lib/chat/human-mention-clipboard.ts";
import { readHumanMentions, withHumanMentionEdit } from "../../../lib/chat/human-mentions.ts";
import { registerComposerEditor } from "../../../lib/composer-input.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  MentionChip,
  separateTypedTextFromMentions,
  setMentionDecorations,
  keepSelectionOutsideMentions,
  restoreMentions,
  rememberMentionHistory,
  mentionDecorations,
} from "./composer-editor-mentions.tsx";

/** CM owns layout, selection, history, clipboard and IME. The hidden native field
 * is only the existing controller's raw-value/event port; its geometry is never used. */
export type ComposerEditorSnapshot = {
  value: string;
  mentions: readonly HumanMention[];
  selection: { start: number; end: number; direction: "forward" | "backward" | "none" };
};

export function mountComposerEditor(
  input: HTMLTextAreaElement,
  mentions: () => readonly HumanMention[],
  application?: ApplicationContext,
  initialHistory?: ComposerEditorSnapshot,
) {
  const configuration = new Compartment();
  let syncing = false;
  let publishing = false;
  let syncScheduled = false;
  let destroyed = false;
  let currentMentions: readonly HumanMention[] = [];
  let currentAttributes = "";
  let mentionSignature = "";
  const focused = input.ownerDocument.activeElement === input;
  const initialSelection = {
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
  };

  const startingSelection = initialHistory?.selection ?? initialSelection;
  function decorations(value = input.value): DecorationSet {
    return Decoration.set(
      currentMentions.flatMap((mention) => {
        const label = value.slice(mention.start, mention.end);
        return label.startsWith("@") && mention.start + 1 < mention.end
          ? [
              Decoration.replace({
                widget: new MentionChip(mention.profileId, label, application),
              }).range(mention.start, mention.end),
            ]
          : [];
      }),
      true,
    );
  }

  function attributes() {
    const attrs: Record<string, string> = {
      role: "textbox",
      "aria-multiline": "true",
      "data-composer-editor": "true",
    };
    for (const name of [
      "aria-label",
      "aria-keyshortcuts",
      "aria-describedby",
      "aria-autocomplete",
      "aria-controls",
      "aria-haspopup",
      "aria-activedescendant",
      "enterkeyhint",
      "autocapitalize",
      "autocorrect",
      "spellcheck",
      "dir",
    ]) {
      const value = input.getAttribute(name);
      if (value !== null) {
        attrs[name] = value;
      }
    }
    attrs["aria-disabled"] = String(input.disabled);
    attrs["aria-readonly"] = String(input.readOnly);
    attrs.tabindex = input.disabled ? "-1" : "0";
    return attrs;
  }
  const canEdit = () => !input.disabled && !input.readOnly;
  function extensions() {
    return [
      EditorView.editable.of(canEdit()),
      EditorState.readOnly.of(!canEdit()),
      EditorView.contentAttributes.of(attributes()),
      EditorView.editorAttributes.of({
        class: [
          "chat-composer-editor",
          input.classList.contains("new-session-page__message") ? "new-session-page__message" : "",
          input.disabled ? "chat-composer-editor--disabled" : "",
        ]
          .filter(Boolean)
          .join(" "),
      }),
      placeholder(input.placeholder),
    ];
  }
  function publishSelection() {
    const selection = view.state.selection.main;
    input.setSelectionRange(
      selection.from,
      selection.to,
      selection.anchor > selection.head ? "backward" : "forward",
    );
  }
  function forward(event: Event) {
    publishSelection();
    let forwarded: Event;
    if (event instanceof PointerEvent) {
      forwarded = new PointerEvent(event.type, event);
    } else if (event instanceof MouseEvent) {
      forwarded = new MouseEvent(event.type, event);
    } else if (event instanceof KeyboardEvent) {
      forwarded = new KeyboardEvent(event.type, event);
    } else if (event instanceof InputEvent) {
      forwarded = new InputEvent(event.type, event);
    } else if (event instanceof CompositionEvent) {
      forwarded = new CompositionEvent(event.type, event);
    } else if (event instanceof FocusEvent) {
      forwarded = new FocusEvent(event.type, event);
    } else {
      forwarded = new Event(event.type, { bubbles: true, cancelable: event.cancelable });
    }
    if (!input.dispatchEvent(forwarded)) {
      event.preventDefault();
    }
    event.stopPropagation();
    return forwarded.defaultPrevented;
  }

  const admittedMentions = readHumanMentions(input.value, mentions()) ?? [];
  currentMentions = initialHistory?.mentions ?? admittedMentions;
  const view = new EditorView({
    parent: input.parentElement!,
    state: EditorState.create({
      doc: initialHistory?.value ?? input.value,
      selection: EditorSelection.single(
        startingSelection.direction === "backward"
          ? startingSelection.end
          : startingSelection.start,
        startingSelection.direction === "backward"
          ? startingSelection.start
          : startingSelection.end,
      ),
      extensions: [
        mentionDecorations.init(() => decorations(initialHistory?.value ?? input.value)),
        separateTypedTextFromMentions,
        keepSelectionOutsideMentions,
        rememberMentionHistory,
        configuration.of(extensions()),
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event) {
              return forward(event);
            },
            keyup(event) {
              return forward(event);
            },
            pointerdown(event) {
              return forward(event);
            },
            pointerup(event) {
              return forward(event);
            },
            click(event) {
              return forward(event);
            },
            beforeinput(event) {
              return forward(event);
            },
            compositionstart(event) {
              if (!canEdit()) {
                return true;
              }
              prepareComposition();
              forward(event);
              return false;
            },
            compositionend(event) {
              finishComposition(event);
              forward(event);
              return false;
            },
            focus(event) {
              forward(event);
              return false;
            },
            blur(event) {
              forward(event);
              return false;
            },
            copy(event) {
              return copySelection(event, false);
            },
            cut(event) {
              return copySelection(event, true);
            },
            paste(event) {
              if (!canEdit()) {
                event.preventDefault();
                return true;
              }
              rememberPastedMentions(event);
              if (forwardPaste(event)) {
                pendingPaste = undefined;
                return true;
              }
              if (!pendingPaste) {
                return false;
              }
              event.preventDefault();
              view.dispatch({
                ...view.state.replaceSelection(pendingPaste.text),
                userEvent: "input.paste",
              });
              return true;
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (syncing || destroyed) {
            return;
          }
          const restoring = update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(restoreMentions)),
          );
          if (update.docChanged || restoring) {
            input.value = update.state.doc.toString();
            publishSelection();
            let inserted = "";
            let editStart = update.startState.doc.length;
            let editEnd = update.docChanged ? 0 : editStart;
            update.changes.iterChanges((from, to, _newFrom, _newTo, text) => {
              editStart = Math.min(editStart, from);
              editEnd = Math.max(editEnd, to);
              inserted += text.toString();
            });
            const source =
              update.transactions
                .find(
                  (transaction) =>
                    transaction.docChanged ||
                    transaction.effects.some((effect) => effect.is(restoreMentions)),
                )
                ?.annotation(Transaction.userEvent) ?? "";
            const inputType = source.startsWith("input.paste")
              ? "insertFromPaste"
              : source.startsWith("input.drop")
                ? "insertFromDrop"
                : source.startsWith("delete.cut")
                  ? "deleteByCut"
                  : source.startsWith("delete.backward")
                    ? "deleteContentBackward"
                    : source.startsWith("delete.forward")
                      ? "deleteContentForward"
                      : source === "undo"
                        ? "historyUndo"
                        : source === "redo"
                          ? "historyRedo"
                          : view.composing
                            ? "insertCompositionText"
                            : inserted === "\n"
                              ? "insertLineBreak"
                              : "insertText";
            // Grouped history stores the earliest complete snapshot last.
            // It must replace identity, not concatenate overlapping snapshots.
            const historical = update.transactions
              .flatMap((transaction) => transaction.effects)
              .findLast((effect) => effect.is(restoreMentions))?.value;
            const pasted = pastedMentions(update);
            const restored = historical ?? pasted;
            publishing = true;
            try {
              withHumanMentionEdit(
                input.value,
                { mode: restoring ? "replace" : "merge", mentions: restored },
                {
                  value: update.startState.doc.toString(),
                  start: editStart,
                  end: editEnd,
                  inputType,
                },
                () =>
                  input.dispatchEvent(
                    new InputEvent("input", {
                      bubbles: true,
                      inputType,
                      data:
                        inputType === "insertText" || inputType === "insertCompositionText"
                          ? inserted || null
                          : null,
                      isComposing: view.composing,
                    }),
                  ),
              );
            } finally {
              publishing = false;
            }
          } else if (update.selectionSet) {
            publishSelection();
            publishing = true;
            try {
              input.dispatchEvent(new Event("select", { bubbles: true }));
            } finally {
              publishing = false;
            }
          }
        }),
        EditorView.theme({
          "&": { outline: "none" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
          ".cm-content": { padding: "0", minHeight: "1lh" },
          ".cm-line": { padding: "0" },
          ".cm-placeholder": { color: "var(--muted)" },
        }),
      ],
    }),
  });

  let compositionPadding: { value: string; removals: { from: number; to: number }[] } | undefined;
  function prepareComposition() {
    compositionPadding = undefined;
    const selection = view.state.selection.main;
    let padLeft = false;
    let padRight = false;
    view.state.field(mentionDecorations).between(selection.from, selection.to, (from, to) => {
      padLeft ||= to === selection.from;
      padRight ||= from === selection.to;
    });
    if (!padLeft && !padRight) {
      return;
    }
    const changes = [
      ...(padLeft ? [{ from: selection.from, insert: " " }] : []),
      ...(padRight ? [{ from: selection.to, insert: " " }] : []),
    ];
    const start = selection.from + Number(padLeft);
    const end = selection.to + Number(padLeft);
    // Reserve boundaries outside the selection BEFORE the IME owns its DOM
    // range. Candidate rewrites must not touch the composed range or join the
    // preceding edit's undo group (compose events always join in CM history).
    view.dispatch({
      changes,
      selection:
        selection.anchor <= selection.head
          ? EditorSelection.range(start, end)
          : EditorSelection.range(end, start),
      userEvent: "input.type.compose.start",
      annotations: isolateHistory.of("before"),
    });
    compositionPadding = {
      value: view.state.doc.toString(),
      removals: changes.map((change, index) => ({
        from: change.from + index,
        to: change.from + index + 1,
      })),
    };
  }
  function finishComposition(event: CompositionEvent) {
    const padding = compositionPadding;
    compositionPadding = undefined;
    if (padding && !event.data && view.state.doc.toString() === padding.value) {
      view.dispatch({
        changes: padding.removals,
        userEvent: "delete.compose",
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }

  let pendingPaste: { text: string; mentions: readonly HumanMention[] } | undefined;
  function copySelection(event: ClipboardEvent, cut: boolean) {
    const { from, to, empty } = view.state.selection.main;
    if (empty || !event.clipboardData) {
      return false;
    }
    const copied: HumanMention[] = [];
    view.state.field(mentionDecorations).between(from, to, (start, end, value) => {
      if (start >= from && end <= to && value.spec.widget instanceof MentionChip) {
        copied.push({
          profileId: value.spec.widget.profileId,
          start: start - from,
          end: end - from,
        });
      }
    });
    if (!copied.length) {
      return false;
    }
    event.clipboardData.setData("text/plain", view.state.sliceDoc(from, to));
    event.clipboardData.setData(HUMAN_MENTION_CLIPBOARD_TYPE, JSON.stringify(copied));
    event.preventDefault();
    if (cut && canEdit()) {
      view.dispatch({
        changes: { from, to },
        selection: EditorSelection.cursor(from),
        userEvent: "delete.cut",
        scrollIntoView: true,
      });
    }
    return true;
  }
  function rememberPastedMentions(event: ClipboardEvent) {
    const copied = readHumanMentionClipboard(event.clipboardData);
    const selection = view.state.selection.main;
    pendingPaste = copied
      ? prepareHumanMentionPaste(view.state.doc.toString(), selection.from, selection.to, copied)
      : undefined;
  }
  function pastedMentions(update: ViewUpdate) {
    const paste = pendingPaste;
    pendingPaste = undefined;
    if (
      !paste ||
      !update.transactions.some((transaction) => transaction.isUserEvent("input.paste"))
    ) {
      return [];
    }
    const restored: HumanMention[] = [];
    update.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      // The atomic boundary filter may pad either side with one separator.
      const offset = text.startsWith(paste.text) ? 0 : text.startsWith(" " + paste.text) ? 1 : -1;
      if (offset < 0 || !["", " "].includes(text.slice(offset + paste.text.length))) {
        return;
      }
      restored.push(
        ...paste.mentions.map((mention) => ({
          profileId: mention.profileId,
          start: mention.start + fromB + offset,
          end: mention.end + fromB + offset,
        })),
      );
    });
    return restored;
  }
  function forwardPaste(event: ClipboardEvent) {
    // Existing attachment paste owns files; CM owns ordinary raw-text paste.
    publishSelection();
    const forwarded = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: event.clipboardData,
    });
    if (!input.dispatchEvent(forwarded)) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  input.after(view.dom);
  input.hidden = true;
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;

  function sync() {
    if (destroyed || syncing) {
      return;
    }
    // Existing input owners may request autosize synchronously while CM is
    // publishing a transaction. Reconcile only after that transaction finishes.
    if (publishing) {
      if (!syncScheduled) {
        syncScheduled = true;
        queueMicrotask(() => {
          syncScheduled = false;
          sync();
        });
      }
      return;
    }
    syncing = true;
    try {
      const next = input.value;
      const previous = view.state.doc.toString();
      const effects: StateEffect<unknown>[] = [];
      const nextMentions = readHumanMentions(input.value, mentions()) ?? [];
      const nextMentionSignature = JSON.stringify(nextMentions);
      const nextAttributes = JSON.stringify([
        attributes(),
        input.disabled,
        input.readOnly,
        input.placeholder,
        input.classList.contains("new-session-page__message"),
      ]);
      if (
        nextMentionSignature !== mentionSignature ||
        nextAttributes !== currentAttributes ||
        next !== previous
      ) {
        currentMentions = nextMentions;
        mentionSignature = nextMentionSignature;
        currentAttributes = nextAttributes;
        effects.push(
          configuration.reconfigure(extensions()),
          setMentionDecorations.of(decorations()),
        );
      }
      view.dom.dataset.composerSingleLine = input.dataset.composerSingleLine ?? "";
      if (input.disabled && view.hasFocus) {
        view.contentDOM.blur();
      }
      view.dom.style.setProperty(
        "--chat-composer-editor-height-limit",
        input.style.getPropertyValue("--chat-composer-editor-height-limit"),
      );
      if (next !== previous) {
        // A minimal raw-text change preserves history and unaffected selections.
        let from = 0;
        while (from < next.length && from < previous.length && next[from] === previous[from]) {
          from++;
        }
        let oldEnd = previous.length,
          newEnd = next.length;
        while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) {
          oldEnd--;
          newEnd--;
        }
        view.dispatch({ changes: { from, to: oldEnd, insert: next.slice(from, newEnd) }, effects });
      } else if (effects.length) {
        view.dispatch({ effects });
      }
    } finally {
      syncing = false;
    }
  }
  function select(start: number, end: number, direction?: string) {
    const anchor = Math.min(view.state.doc.length, direction === "backward" ? end : start);
    const head = Math.min(view.state.doc.length, direction === "backward" ? start : end);
    view.dispatch({ selection: EditorSelection.single(anchor, head), scrollIntoView: true });
  }
  const unregister = registerComposerEditor(input, {
    element: view.dom,
    focusElement: view.contentDOM,
    scrollElement: view.scrollDOM,
    coordsAtPos(position) {
      return view.coordsAtPos(Math.min(position, view.state.doc.length));
    },
    sync,
    focus(options) {
      view.contentDOM.focus(options);
    },
    select,
    replace(text, from, to) {
      sync();
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
    },
  });
  // Container queries can shrink the scrollport without a document change.
  // Keep the active caret visible after that real geometry change.
  let resizeFrame: number | undefined;
  const requestViewportScroll = () => {
    if (destroyed) {
      return;
    }
    view.requestMeasure();
    if (resizeFrame !== undefined) {
      cancelAnimationFrame(resizeFrame);
    }
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = undefined;
      if (!destroyed && view.hasFocus && !view.composing) {
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, {
            x: "nearest",
            y: "nearest",
            xMargin: 0,
            yMargin: 0,
          }),
        });
      }
    });
  };
  const resizeObserver =
    typeof ResizeObserver === "function" ? new ResizeObserver(requestViewportScroll) : undefined;
  resizeObserver?.observe(view.scrollDOM);
  const stopResize = resizeObserver ? undefined : listen(window, "resize", requestViewportScroll);
  const observer = new MutationObserver(sync);
  observer.observe(input, {
    attributes: true,
    attributeFilter: [
      "disabled",
      "readonly",
      "placeholder",
      "aria-label",
      "aria-keyshortcuts",
      "aria-describedby",
      "aria-controls",
      "aria-haspopup",
      "aria-activedescendant",
      "dir",
      "data-composer-single-line",
      "style",
    ],
  });
  const stopScroll = listen(view.scrollDOM, "scroll", () =>
    input.dispatchEvent(new Event("scroll")),
  );
  if (initialHistory) {
    // Native insertion already updated its owner while CM was loading. Seed
    // text and recipient history without publishing that insertion twice.
    syncing = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: input.value },
        selection: EditorSelection.single(initialSelection.start, initialSelection.end),
        userEvent: "input.paste",
        effects: restoreMentions.of(admittedMentions),
      });
    } finally {
      syncing = false;
    }
  }
  sync();
  if (
    !input.disabled &&
    (focused || (input.autofocus && input.ownerDocument.activeElement === input.ownerDocument.body))
  ) {
    view.focus();
  }
  return {
    sync,
    destroy() {
      destroyed = true;
      observer.disconnect();
      resizeObserver?.disconnect();
      stopResize?.();
      if (resizeFrame !== undefined) {
        cancelAnimationFrame(resizeFrame);
      }
      stopScroll();
      unregister();
      view.destroy();
      view.dom.remove();
      input.hidden = false;
      input.removeAttribute("aria-hidden");
      input.removeAttribute("tabindex");
    },
  };
}
