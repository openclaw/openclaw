import { history, isolateHistory } from "@codemirror/commands";
import { Compartment, Prec, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import {
  normalizeChipSelection,
  chipDecorations,
  chipResolver,
  setChips,
  type ComposerChipContext,
  type ComposerChipResolver,
} from "./composer-editor-chips.ts";
import { composerKeymap } from "./composer-editor-keymap.ts";
export type {
  ComposerChip,
  ComposerChipContext,
  ComposerChipResolver,
} from "./composer-editor-chips.ts";

const ariaReferenceAttributes = new Set([
  "aria-controls",
  "aria-activedescendant",
  "aria-describedby",
  "aria-labelledby",
]);
/** Textarea-shaped adapter; chips are presentation only, value and clipboard always contain raw text. */
export class ComposerEditor extends HTMLElement {
  static observedAttributes = [
    "disabled",
    "readonly",
    "placeholder",
    "dir",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-controls",
    "aria-expanded",
    "aria-activedescendant",
    "aria-autocomplete",
    "aria-keyshortcuts",
  ];
  private chipProvider?: ComposerChipResolver;
  private chipContext: ComposerChipContext = { editing: false, caret: 0 };
  private view?: EditorView;
  private savedValue = "";
  private savedSelection = EditorSelection.single(0);
  private configuration = new Compartment();
  private undoHistory = new Compartment();
  private programmatic = false;
  private selectTask?: object;
  private ariaReferenceTask?: object;
  private pendingInput?: { inputType: string; data: string | null };

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; min-width: 0; width: 100%; }
      .composer-chip { display: inline-flex; vertical-align: baseline; align-items: baseline; gap: 0.3em;
        max-width: min(24em, 80vw, calc(100% - 0.12em)); box-sizing: border-box; padding: 0 0.4em; margin: 0 0.06em;
        border: 1px solid var(--accent); border-radius: var(--radius-sm, 6px);
        color: var(--accent); background: var(--accent-subtle, transparent); font: inherit;
        line-height: 1.35; unicode-bidi: isolate; }
      .composer-chip__icon { display: inline-flex; flex: 0 0 auto; width: 1em; height: 1em; align-items: center; justify-content: center; align-self: center; }
      .composer-chip__icon svg, .composer-chip__icon img { width: 100%; height: 100%; object-fit: cover; }
      .composer-chip__icon img { border-radius: 50%; }
      .composer-chip__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      :host([disabled]) { opacity: 0.6; }
    `;
    root.append(style);
  }
  connectedCallback() {
    if (this.view) {
      return;
    }
    this.view = new EditorView({
      parent: this.shadowRoot!,
      dispatchTransactions: (transactions, view) => {
        const transaction = transactions.find((candidate) => candidate.docChanged);
        let input = this.pendingInput;
        if (transaction) {
          this.pendingInput = undefined;
        }
        if (transaction && !this.programmatic) {
          let inserted = "";
          let changeStart = 0;
          transaction.changes.iterChanges((from, _to, _newFrom, _newTo, text) => {
            changeStart = from;
            inserted += text.toString();
          });
          const inputType = transaction.isUserEvent("undo")
            ? "historyUndo"
            : transaction.isUserEvent("redo")
              ? "historyRedo"
              : transaction.isUserEvent("input.paste")
                ? "insertFromPaste"
                : transaction.isUserEvent("input.drop")
                  ? "insertFromDrop"
                  : transaction.isUserEvent("move.character")
                    ? "insertTranspose"
                    : transaction.isUserEvent("delete.word.forward")
                      ? "deleteWordForward"
                      : transaction.isUserEvent("delete.word.backward")
                        ? "deleteWordBackward"
                        : transaction.isUserEvent("delete.cut")
                          ? "deleteByCut"
                          : (input?.inputType ??
                            (transaction.isUserEvent("delete")
                              ? changeStart >= transaction.startState.selection.main.head
                                ? "deleteContentForward"
                                : "deleteContentBackward"
                              : inserted === "\n"
                                ? "insertLineBreak"
                                : "insertText"));
          const data = input?.data ?? (inputType === "insertText" ? inserted : null);
          if (!input) {
            const before = new InputEvent("beforeinput", {
              bubbles: true,
              composed: true,
              cancelable: true,
              inputType,
              data,
              isComposing: view.composing,
            });
            if (!this.dispatchEvent(before)) {
              return;
            }
          }
          input = { inputType, data };
        }
        const finalState = transactions.at(-1)?.state ?? view.state;
        const selection = normalizeChipSelection(finalState);
        const updates = selection.eq(finalState.selection)
          ? transactions
          : [
              ...transactions,
              finalState.update({
                selection,
                annotations: Transaction.addToHistory.of(false),
                scrollIntoView: transactions.some((update) => update.scrollIntoView),
              }),
            ];
        view.update(updates);
        if (transaction && !this.programmatic && input) {
          this.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              composed: true,
              ...input,
              isComposing: view.composing,
            }),
          );
        }
        if (
          updates.some(
            (candidate) =>
              candidate.selection && !candidate.selection.eq(candidate.startState.selection),
          )
        ) {
          this.queueSelect();
        }
      },
      state: EditorState.create({
        doc: this.savedValue,
        selection: this.savedSelection,
        extensions: [
          this.undoHistory.of(history()),
          composerKeymap(this),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { font: "inherit", color: "inherit", backgroundColor: "transparent" },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": { font: "inherit", overflow: "visible" },
            ".cm-content": {
              padding: "0",
              minHeight: "1.5em",
              minWidth: "0",
              caretColor: "var(--text)",
              overflowWrap: "anywhere",
            },
            ".cm-line": { padding: "0" },
            ".cm-placeholder": {
              color: "var(--chat-composer-tertiary, var(--muted))",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          }),
          chipDecorations,
          chipResolver.of((value, context) => {
            this.chipContext = { ...context, editing: context.editing && !this.programmatic };
            return this.chipProvider?.(value, this.chipContext);
          }),
          this.configuration.of(this.attributesExtension()),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event) => {
                this.pendingInput = undefined;
                const forwarded = new KeyboardEvent("keydown", {
                  key: event.key,
                  // IME confirmation still uses keyCode 229 after compositionend.
                  keyCode: event.keyCode,
                  location: event.location,
                  code: event.code,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  repeat: event.repeat,
                  isComposing: event.isComposing,
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                });
                event.stopPropagation();
                this.dispatchEvent(forwarded);
                return forwarded.defaultPrevented;
              },
              blur: () => {
                this.refreshChips();
                return false;
              },
              input: (event) => {
                event.stopPropagation();
                return false;
              },
              drop: (event) => {
                const forwarded = new DragEvent("drop", {
                  dataTransfer: event.dataTransfer,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                });
                event.stopPropagation();
                this.dispatchEvent(forwarded);
                // Attachments belong to the surrounding composer; never let CodeMirror
                // schedule its asynchronous file-to-text insertion.
                return forwarded.defaultPrevented || Boolean(event.dataTransfer?.files.length);
              },
              copy: (_event, view) => view.state.selection.main.empty,
              cut: (_event, view) => view.state.selection.main.empty,
              paste: (event, view) => {
                const forwarded = new ClipboardEvent("paste", {
                  clipboardData: event.clipboardData,
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                });
                event.stopPropagation();
                this.dispatchEvent(forwarded);
                if (forwarded.defaultPrevented || this.disabled || this.readOnly) {
                  return true;
                }
                const text =
                  event.clipboardData?.getData("text/plain") ||
                  event.clipboardData?.getData("text/uri-list");
                // Browser paste events provide clipboardData. Insert at the selection,
                // without CodeMirror's cross-editor remembered linewise-copy policy.
                if (text) {
                  view.dispatch({
                    ...view.state.replaceSelection(text),
                    userEvent: "input.paste",
                    scrollIntoView: true,
                  });
                }
                return true;
              },
              beforeinput: (event, view) => {
                const forwarded = new InputEvent("beforeinput", {
                  inputType: event.inputType,
                  data: event.data,
                  isComposing: event.isComposing,
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                });
                event.stopPropagation();
                this.dispatchEvent(forwarded);
                if (forwarded.defaultPrevented) {
                  return true;
                }
                this.pendingInput = { inputType: event.inputType, data: event.data };
                // Mobile deletion may target one code unit without running a keyboard command.
                if (
                  event.inputType !== "deleteContentBackward" &&
                  event.inputType !== "deleteContentForward"
                ) {
                  return false;
                }
                const selection = view.state.selection.main;
                if (!selection.empty) {
                  return false;
                }
                let range: { from: number; to: number } | undefined;
                view.state.field(chipDecorations).between(0, view.state.doc.length, (from, to) => {
                  if (
                    event.inputType === "deleteContentBackward"
                      ? selection.head > from && selection.head <= to
                      : selection.head >= from && selection.head < to
                  ) {
                    range = { from, to };
                  }
                });
                if (!range) {
                  return false;
                }
                view.dispatch({
                  changes: range,
                  selection: { anchor: range.from },
                  userEvent: "delete",
                });
                return true;
              },
            }),
          ),
        ],
      }),
    });
    // The host owns scrolling. Keep the internal scroller out of native focus
    // delegation so focus lands on the editable surface instead.
    this.view.scrollDOM.removeAttribute("tabindex");
    this.refreshChips();
    this.queueAriaReferences();
    if (this.hasAttribute("autofocus")) {
      const view = this.view;
      queueMicrotask(() => {
        if (this.isConnected && this.view === view) {
          this.focus();
        }
      });
    }
  }
  private queueSelect() {
    if (this.selectTask) {
      return;
    }
    const task = (this.selectTask = {});
    // Like textarea selection events, notify after the input owner can record the new draft.
    queueMicrotask(() => {
      if (this.selectTask !== task) {
        return;
      }
      this.selectTask = undefined;
      if (this.isConnected) {
        this.dispatchEvent(new Event("select", { bubbles: true }));
      }
    });
  }
  private queueAriaReferences() {
    if (!this.view || this.ariaReferenceTask) {
      return;
    }
    const task = (this.ariaReferenceTask = {});
    // Lit creates the external popup after the editor. Element references cross the
    // shadow boundary; copying its string IDs into contentDOM does not.
    queueMicrotask(() => {
      if (this.ariaReferenceTask !== task) {
        return;
      }
      this.ariaReferenceTask = undefined;
      const root = this.getRootNode();
      if (
        !this.isConnected ||
        !this.view ||
        !(root instanceof Document || root instanceof ShadowRoot)
      ) {
        return;
      }
      const references = (attribute: string) =>
        (this.getAttribute(attribute) ?? "").split(/\s+/).flatMap((id) => {
          const element = root.getElementById(id);
          return element ? [element] : [];
        });
      const content = this.view.contentDOM;
      content.ariaControlsElements = references("aria-controls");
      content.ariaActiveDescendantElement = references("aria-activedescendant")[0] ?? null;
      content.ariaDescribedByElements = references("aria-describedby");
      content.ariaLabelledByElements = references("aria-labelledby");
    });
  }
  disconnectedCallback() {
    this.selectTask = undefined;
    this.ariaReferenceTask = undefined;
    if (!this.view) {
      return;
    }
    this.savedValue = this.value;
    this.savedSelection = this.view.state.selection;
    this.view.destroy();
    this.view = undefined;
  }
  attributeChangedCallback() {
    this.view?.dispatch({ effects: this.configuration.reconfigure(this.attributesExtension()) });
    this.queueAriaReferences();
  }
  private attributesExtension() {
    const attributes: Record<string, string> = {
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "",
    };
    for (const name of ComposerEditor.observedAttributes) {
      if (
        (name.startsWith("aria-") || name === "dir") &&
        !ariaReferenceAttributes.has(name) &&
        this.hasAttribute(name)
      ) {
        attributes[name] = this.getAttribute(name)!;
      }
    }
    if (this.disabled) {
      attributes["aria-disabled"] = "true";
    } else {
      attributes.tabindex = "0";
    }
    if (this.readOnly) {
      attributes["aria-readonly"] = "true";
    }
    return [
      EditorState.readOnly.of(this.disabled || this.readOnly),
      EditorView.editable.of(!this.disabled && !this.readOnly),
      EditorView.contentAttributes.of(attributes),
      placeholder(this.placeholder),
    ];
  }
  get value() {
    return this.view?.state.doc.toString() ?? this.savedValue;
  }
  set value(raw: string) {
    const value = raw.replace(/\r\n?/g, "\n");
    const old = this.value;
    if (old === value) {
      return;
    }
    if (!this.view) {
      this.savedValue = value;
      this.savedSelection = EditorSelection.single(value.length);
      return;
    }
    let from = 0;
    while (from < old.length && from < value.length && old[from] === value[from]) {
      from++;
    }
    let end = old.length,
      nextEnd = value.length;
    while (end > from && nextEnd > from && old[end - 1] === value[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    this.programmatic = true;
    try {
      this.view.dispatch({
        changes: { from, to: end, insert: value.slice(from, nextEnd) },
        selection: { anchor: value.length },
        userEvent: "input.complete",
        annotations: isolateHistory.of("full"),
      });
    } finally {
      this.programmatic = false;
    }
    if (value === "") {
      this.clearUndoHistory();
    }
  }
  private clearUndoHistory() {
    if (!this.view) {
      return;
    }
    this.view.dispatch({ effects: this.undoHistory.reconfigure([]) });
    this.view.dispatch({ effects: this.undoHistory.reconfigure(history()) });
  }
  /** Draft owners call this after submission or a conversation switch to discard the previous undo stack. */
  resetValue(raw = "") {
    this.value = raw;
    const value = this.value;
    if (this.view) {
      this.clearUndoHistory();
      this.view.dispatch({ selection: { anchor: value.length } });
    } else {
      this.savedSelection = EditorSelection.single(value.length);
    }
    this.refreshChips();
  }
  get resolveChips() {
    return this.chipProvider;
  }
  set resolveChips(provider: ComposerChipResolver | undefined) {
    this.chipProvider = provider;
    this.view?.dispatch({
      effects: setChips.of(provider?.(this.value, this.chipContext) ?? []),
    });
    this.queueAriaReferences();
  }
  /** Re-evaluate a hydrated catalog or confirm the unchanged raw token after a menu choice. */
  refreshChips() {
    this.chipContext = {
      editing: false,
      caret: this.view?.state.selection.main.head ?? this.selectionEnd,
    };
    this.view?.dispatch({
      effects: setChips.of(this.chipProvider?.(this.value, this.chipContext) ?? []),
    });
  }
  get selectionStart() {
    return (this.view?.state.selection ?? this.savedSelection).main.from;
  }
  set selectionStart(start: number) {
    this.setSelectionRange(start, Math.max(start, this.selectionEnd));
  }
  get selectionEnd() {
    return (this.view?.state.selection ?? this.savedSelection).main.to;
  }
  set selectionEnd(end: number) {
    this.setSelectionRange(Math.min(this.selectionStart, end), end);
  }
  get selectionDirection(): "forward" | "backward" | "none" {
    const range = (this.view?.state.selection ?? this.savedSelection).main;
    return range.empty ? "none" : range.anchor > range.head ? "backward" : "forward";
  }
  set selectionDirection(direction: "forward" | "backward" | "none") {
    this.setSelectionRange(this.selectionStart, this.selectionEnd, direction);
  }
  setSelectionRange(rawStart: number, rawEnd: number, direction = "none") {
    const end = Math.max(0, Math.min(rawEnd, this.value.length));
    const start = Math.max(0, Math.min(rawStart, end));
    const selection = EditorSelection.single(
      direction === "backward" ? end : start,
      direction === "backward" ? start : end,
    );
    this.savedSelection = selection;
    this.view?.dispatch({ selection });
  }
  setRangeText(
    rawReplacement: string,
    start = this.selectionStart,
    end = this.selectionEnd,
    mode: SelectionMode = "preserve",
  ) {
    const replacement = rawReplacement.replace(/\r\n?/g, "\n");
    const previousStart = this.selectionStart,
      previousEnd = this.selectionEnd;
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    const insertedEnd = start + replacement.length;
    const delta = insertedEnd - end;
    this.setSelectionRange(
      mode === "select" || mode === "start"
        ? start
        : mode === "end"
          ? insertedEnd
          : previousStart > end
            ? previousStart + delta
            : Math.min(previousStart, start),
      mode === "select" || mode === "end"
        ? insertedEnd
        : mode === "start"
          ? start
          : previousEnd > end
            ? previousEnd + delta
            : previousEnd < start
              ? previousEnd
              : insertedEnd,
    );
  }
  coordsAtPos(offset: number) {
    return this.view?.coordsAtPos(offset) ?? null;
  }
  insertText(text: string): boolean {
    if (!this.view || this.disabled || this.readOnly) {
      return false;
    }
    this.view.dispatch({ ...this.view.state.replaceSelection(text), userEvent: "input" });
    return true;
  }
  select() {
    this.setSelectionRange(0, this.value.length);
  }
  override focus(options?: FocusOptions) {
    if (!this.disabled) {
      this.view?.contentDOM.focus(options);
    }
  }
  override blur() {
    this.view?.contentDOM.blur();
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(value: boolean) {
    this.toggleAttribute("disabled", value);
  }
  get readOnly() {
    return this.hasAttribute("readonly");
  }
  set readOnly(value: boolean) {
    this.toggleAttribute("readonly", value);
  }
  get placeholder() {
    return this.getAttribute("placeholder") ?? "";
  }
  set placeholder(value: string) {
    this.setAttribute("placeholder", value);
  }
}

customElements.define("openclaw-composer-editor", ComposerEditor);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-composer-editor": ComposerEditor;
  }
}
