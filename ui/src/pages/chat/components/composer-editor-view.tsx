import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type Extension,
  type SelectionRange,
  type StateEffect,
} from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder, type ViewUpdate } from "@codemirror/view";
import { registerComposerEditor } from "../../../lib/composer-input.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { composerEditorTheme } from "./composer-editor-theme.ts";

const INPUT_TYPES: Partial<Record<string, string>> = {
  "input.paste": "insertFromPaste",
  "input.drop": "insertFromDrop",
  "move.drop": "insertFromDrop",
  "delete.cut": "deleteByCut",
  "delete.backward": "deleteContentBackward",
  "delete.forward": "deleteContentForward",
  undo: "historyUndo",
  redo: "historyRedo",
};

type ComposerInputEdit = { value: string; start: number; end: number; inputType: string };
type PublishComposerInput = (
  wrap?: (edit: ComposerInputEdit, emit: () => void, next: string) => void,
) => void;

/** Native CodeMirror extensions own decoration semantics. These two hooks bridge
 * external draft state and input metadata without teaching the editor a token kind. */
export type ComposerEditorOptions = {
  extensions: Extension;
  sync?: (view: EditorView, previous: string) => readonly StateEffect<unknown>[];
  onEdit?: (update: ViewUpdate, publish: PublishComposerInput) => void;
};

/** CM owns layout, selection, history, clipboard and IME. The hidden native field
 * is only the existing controller's raw-value/event port; its geometry is never used.
 * The binding owns attribute observation and calls sync after external changes. */
export type ComposerEditorSnapshot = {
  value: string;
  selection: { start: number; end: number; direction: "forward" | "backward" | "none" };
};

export function mountComposerEditor(
  input: HTMLTextAreaElement,
  options: ComposerEditorOptions,
  initialHistory?: ComposerEditorSnapshot,
) {
  const configuration = new Compartment();
  const undoHistory = new Compartment();
  let syncing = false;
  let publishing = false;
  let syncScheduled = false;
  let destroyed = false;
  let currentAttributes = "";
  const focused = input.ownerDocument.activeElement === input;
  const initialSelection = {
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
  };

  const startingSelection = initialHistory?.selection ?? initialSelection;
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
      "dir",
    ]) {
      const value = input.getAttribute(name);
      if (value !== null) {
        attrs[name] = value;
      }
    }
    // CodeMirror defaults these off for code; keep the composer's native text entry.
    attrs.spellcheck = String(input.spellcheck);
    attrs.autocorrect = input.getAttribute("autocorrect") ?? "on";
    attrs.autocapitalize = input.getAttribute("autocapitalize") ?? "sentences";
    attrs.writingsuggestions = input.getAttribute("writingsuggestions") ?? "true";
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
      // Copy named fields, never the event: WebKit also copies its legacy
      // keyIdentifier, and an untrusted keydown carrying it runs default actions
      // on the port (Backspace history navigation, Tab focus, page scrolling).
      forwarded = new KeyboardEvent(event.type, {
        bubbles: true,
        cancelable: event.cancelable,
        composed: event.composed,
        key: event.key,
        code: event.code,
        location: event.location,
        repeat: event.repeat,
        isComposing: event.isComposing,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        keyCode: event.keyCode,
        charCode: event.charCode,
        which: event.which,
      });
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

  // A pointer press inside the selection may become a drag of that selection.
  // A press that ends without a drag forgets it, so a later drag that has no
  // mousedown of its own (touch) never restores an old selection.
  let grabbed: SelectionRange | undefined;
  const stopGrab = listen(
    input.ownerDocument,
    "mouseup",
    () => {
      grabbed = undefined;
    },
    true,
  );
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
        options.extensions,
        configuration.of(extensions()),
        EditorView.lineWrapping,
        drawSelection({ drawRangeCursor: false }),
        undoHistory.of(history()),
        // Textarea editing, not code editing: no auto-indent or line commands.
        keymap.of([
          { key: "Enter", run: insertNewline, shift: insertNewline },
          ...standardKeymap,
          ...historyKeymap,
        ]),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: forward,
            keyup: forward,
            pointerdown: forward,
            pointerup: forward,
            click: forward,
            beforeinput: forward,
            compositionstart(event) {
              if (!canEdit()) {
                return true;
              }
              forward(event);
              return false;
            },
            compositionend(event) {
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
            mousedown(event) {
              const { main } = view.state.selection;
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
              grabbed =
                event.button === 0 &&
                event.detail <= 1 &&
                !main.empty &&
                position >= main.from &&
                position <= main.to
                  ? main
                  : undefined;
              return false;
            },
            dragstart() {
              // WebKit delivers a fast first mousemove before dragstart, so CodeMirror
              // has already replaced the grabbed selection with a new one. Drag what
              // the user grabbed; later handlers read the selection for the payload.
              if (grabbed && !view.state.selection.main.eq(grabbed)) {
                view.dispatch({ selection: grabbed });
              }
              grabbed = undefined;
              return false;
            },
            drop(event) {
              // Files belong to the attachment owner, whose listener still receives
              // the bubbling drop; CodeMirror must not also insert their contents.
              return Boolean(event.dataTransfer?.files.length);
            },
            paste(event) {
              if (!canEdit()) {
                event.preventDefault();
                return true;
              }
              return forwardPaste(event);
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (syncing || destroyed) {
            return;
          }
          let published = false;
          const publish: PublishComposerInput = (wrap) => {
            published = true;
            const next = update.state.doc.toString();
            input.value = next;
            publishSelection();
            const source =
              update.transactions
                .find(
                  (transaction) =>
                    transaction.docChanged ||
                    transaction.annotation(Transaction.userEvent) !== undefined,
                )
                ?.annotation(Transaction.userEvent) ?? "";
            const knownInputType = INPUT_TYPES[source.split(".").slice(0, 2).join(".")];
            let inserted = "";
            let editStart = update.startState.doc.length;
            let editEnd = update.docChanged ? 0 : editStart;
            update.changes.iterChanges((from, to, _newFrom, _newTo, text) => {
              editStart = Math.min(editStart, from);
              editEnd = Math.max(editEnd, to);
              if (knownInputType === undefined) {
                inserted += text.toString();
              }
            });
            const inputType =
              knownInputType ??
              (view.composing
                ? "insertCompositionText"
                : inserted === "\n"
                  ? "insertLineBreak"
                  : "insertText");

            const emit = () =>
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
              );
            publishing = true;
            try {
              if (wrap) {
                wrap(
                  {
                    value: update.startState.doc.toString(),
                    start: editStart,
                    end: editEnd,
                    inputType,
                  },
                  emit,
                  next,
                );
              } else {
                emit();
              }
            } finally {
              publishing = false;
            }
          };
          options.onEdit?.(update, publish);
          if (!published && update.docChanged) {
            publish();
          }
          if (!published && update.selectionSet) {
            publishSelection();
            publishing = true;
            try {
              input.dispatchEvent(new Event("select", { bubbles: true }));
            } finally {
              publishing = false;
            }
          }
        }),
        composerEditorTheme,
      ],
    }),
  });

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

  // Coalesces owner writes made in one task; they run inside Solid's apply
  // phase, so the foreign renderer reconciles after that commit.
  function requestSync() {
    if (!syncScheduled) {
      syncScheduled = true;
      queueMicrotask(() => {
        syncScheduled = false;
        sync();
      });
    }
  }
  function sync() {
    if (destroyed || syncing) {
      return;
    }
    // Existing input owners may request autosize synchronously while CM is
    // publishing a transaction. Reconcile only after that transaction finishes.
    if (publishing) {
      requestSync();
      return;
    }
    syncing = true;
    try {
      const next = input.value;
      const previous = view.state.doc.toString();
      let effects = options.sync?.(view, previous) ?? [];
      const nextAttributes = JSON.stringify([
        attributes(),
        input.disabled,
        input.readOnly,
        input.placeholder,
        input.classList.contains("new-session-page__message"),
      ]);
      if (nextAttributes !== currentAttributes) {
        currentAttributes = nextAttributes;
        effects = [...effects, configuration.reconfigure(extensions())];
      }
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
        view.dispatch({
          changes: { from, to: oldEnd, insert: next.slice(from, newEnd) },
          effects,
          userEvent: "input.complete",
        });
      } else if (effects.length) {
        view.dispatch({ effects, userEvent: "input.complete" });
      }
      if (!next && previous) {
        // An owner clear (send, discard) ends the draft; undo must not restore it,
        // matching a native textarea's programmatic value replacement.
        view.dispatch({ effects: undoHistory.reconfigure([]) });
        view.dispatch({ effects: undoHistory.reconfigure(history()) });
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
    requestSync,
    focus(focusOptions) {
      view.contentDOM.focus(focusOptions);
    },
    select,
    replace(text, from, to) {
      sync();
      view.dispatch({
        changes: { from, to, insert: text },
        userEvent: "input.complete",
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
  if (initialHistory) {
    // Native insertion already updated its owner while CM was loading. Seed
    // text and recipient history without publishing that insertion twice.
    syncing = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: input.value },
        selection:
          initialSelection.direction === "backward"
            ? EditorSelection.single(initialSelection.end, initialSelection.start)
            : EditorSelection.single(initialSelection.start, initialSelection.end),
        userEvent: "input.paste",
        effects: options.sync?.(view, view.state.doc.toString()),
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
    view,
    sync,
    destroy(this: void) {
      destroyed = true;
      resizeObserver?.disconnect();
      stopResize?.();
      stopGrab();
      if (resizeFrame !== undefined) {
        cancelAnimationFrame(resizeFrame);
      }
      unregister();
      view.destroy();
      input.hidden = false;
      input.removeAttribute("aria-hidden");
      input.removeAttribute("tabindex");
    },
  };
}
