import "../../../styles/chat/composer-surface.css";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { render } from "@solidjs/web";
import type { ApplicationContext } from "../../../app/context-types.ts";
import { PersonReferenceLabel } from "../../../components/solid/person-reference-label.tsx";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { registerComposerEditor } from "../../../lib/composer-input.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { listen } from "../../../lib/reactive/listener.ts";

const avatarDisposers = new WeakMap<HTMLElement, () => void>();
class MentionAvatar extends WidgetType {
  constructor(
    readonly profileId: string,
    readonly label: string,
    readonly application: ApplicationContext | undefined,
  ) {
    super();
  }
  override eq(other: MentionAvatar) {
    return other.profileId === this.profileId && other.label === this.label;
  }
  toDOM() {
    const node = document.createElement("span");
    node.className = "chat-composer-mention-avatar";
    node.setAttribute("aria-hidden", "true");
    avatarDisposers.set(
      node,
      // Provide the capability in this separate root; CM owns its lifetime.
      render(
        () =>
          this.application ? (
            <ApplicationProvider value={this.application}>
              <PersonReferenceLabel profileId={this.profileId} label={this.label} avatarOnly />
            </ApplicationProvider>
          ) : (
            <PersonReferenceLabel profileId={this.profileId} label={this.label} avatarOnly />
          ),
        node,
      ),
    );
    return node;
  }
  override destroy(node: HTMLElement) {
    avatarDisposers.get(node)?.();
    avatarDisposers.delete(node);
  }
  override ignoreEvent() {
    return false;
  }
}

/** CM owns layout, selection, history, clipboard and IME. The hidden native field
 * is only the existing controller's raw-value/event port; its geometry is never used. */
export function mountComposerEditor(
  input: HTMLTextAreaElement,
  mentions: () => readonly HumanMention[],
  application?: ApplicationContext,
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

  function decorations(): DecorationSet {
    const ranges = currentMentions.flatMap((mention) => {
      const label = input.value.slice(mention.start, mention.end);
      if (!label.startsWith("@") || mention.start + 1 >= mention.end) {
        return [];
      }
      return [
        Decoration.replace({
          widget: new MentionAvatar(mention.profileId, label, application),
        }).range(mention.start, mention.start + 1),
        Decoration.mark({
          class: "markdown-person-reference chat-composer-mention-label",
          inclusiveStart: true,
        }).range(mention.start, mention.end),
      ];
    });
    return Decoration.set(ranges, true);
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
  function extensions() {
    return [
      EditorView.editable.of(!input.disabled),
      EditorState.readOnly.of(input.disabled || input.readOnly),
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
      EditorView.decorations.of(decorations()),
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

  currentMentions = readHumanMentions(input.value, mentions()) ?? [];
  const view = new EditorView({
    parent: input.parentElement!,
    state: EditorState.create({
      doc: input.value,
      selection: EditorSelection.single(
        initialSelection.direction === "backward" ? initialSelection.end : initialSelection.start,
        initialSelection.direction === "backward" ? initialSelection.start : initialSelection.end,
      ),
      extensions: [
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
            paste(event) {
              return forwardPaste(event);
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (syncing || destroyed) {
            return;
          }
          if (update.docChanged) {
            input.value = update.state.doc.toString();
            publishSelection();
            let inserted = "";
            update.changes.iterChanges((_from, _to, _newFrom, _newTo, text) => {
              inserted += text.toString();
            });
            const source =
              update.transactions
                .find((transaction) => transaction.docChanged)
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
            publishing = true;
            try {
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
        effects.push(configuration.reconfigure(extensions()));
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
