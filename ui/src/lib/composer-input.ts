/** Compatibility boundary for composer owners. Values and offsets remain raw text. */
export type ComposerEditorBridge = {
  element: HTMLElement;
  focusElement: HTMLElement;
  scrollElement: HTMLElement;
  coordsAtPos: (
    position: number,
  ) => { left: number; right: number; top: number; bottom: number } | null;
  sync: () => void;
  requestSync: () => void;
  focus: (options?: FocusOptions) => void;
  select: (start: number, end: number, direction?: "forward" | "backward" | "none") => void;
  replace: (text: string, start: number, end: number) => void;
  /** Replace the whole draft as one isolated history step. */
  replaceAll: (text: string) => void;
  /** Step the editor's own history back, restoring mention identities with the text. */
  undo: () => void;
};
const editors = new WeakMap<HTMLTextAreaElement, ComposerEditorBridge>();
export function registerComposerEditor(input: HTMLTextAreaElement, editor: ComposerEditorBridge) {
  editors.set(input, editor);
  return () => editors.delete(input);
}
export function readComposerEditor(input: HTMLTextAreaElement) {
  return editors.get(input);
}
export function composerInputElement(input: HTMLElement): HTMLElement {
  return input instanceof HTMLTextAreaElement ? (editors.get(input)?.element ?? input) : input;
}
export function composerInputFocusElement(input: HTMLTextAreaElement): HTMLElement {
  return editors.get(input)?.focusElement ?? input;
}
/** For controlled-value writers; the editor reconciles after the current commit. */
export function syncComposerInput(input: HTMLTextAreaElement) {
  editors.get(input)?.requestSync();
}
export function focusComposerInput(
  input: HTMLTextAreaElement | null | undefined,
  options?: FocusOptions,
) {
  if (!input || input.disabled) {
    return;
  }
  const editor = editors.get(input);
  if (editor) {
    editor.sync();
    editor.focus(options);
  } else {
    input.focus(options);
  }
}
export function composerInputHasFocus(input: HTMLTextAreaElement | null | undefined) {
  return Boolean(input && composerInputElement(input).contains(input.ownerDocument.activeElement));
}
export function selectComposerInput(
  input: HTMLTextAreaElement | null | undefined,
  start: number,
  end: number,
  direction?: "forward" | "backward" | "none",
) {
  if (!input) {
    return;
  }
  input.setSelectionRange(start, end, direction);
  const editor = editors.get(input);
  if (editor) {
    editor.sync();
    editor.select(start, end, direction);
  }
}

export type ComposerDraftTransaction = {
  value: string;
  committed: boolean | undefined;
  canUndo: () => boolean;
  undo: (isCurrent?: () => boolean) => boolean | undefined;
};

/** A known composer's isolated history step, with a target-scoped undo receipt. */
export function replaceComposerDraft(
  target: HTMLTextAreaElement,
  text: string,
  isCurrent?: () => boolean,
): ComposerDraftTransaction {
  const before = {
    value: target.value,
    start: target.selectionStart,
    end: target.selectionEnd,
    direction: target.selectionDirection,
  };
  const editor = readComposerEditor(target);
  focusComposerInput(target, { preventScroll: true });
  if (
    isCurrent &&
    (!isCurrent() ||
      target.value !== before.value ||
      readComposerEditor(target) !== editor ||
      target.disabled ||
      target.readOnly)
  ) {
    return { value: text, committed: false, canUndo: () => false, undo: () => false };
  }
  if (editor) {
    editor.replaceAll(text);
  } else {
    target.setSelectionRange(0, target.value.length);
    if (!target.ownerDocument.execCommand?.("insertText", false, text)) {
      target.setRangeText(text, 0, target.value.length, "end");
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
    }
  }
  // Input handlers run inside the write. A changed value after dispatch cannot
  // prove that no write happened; preserve an unknown receipt instead of retrying.
  const committed = target.value === text ? before.value !== text : undefined;
  let used = false;
  const targetMatches = () =>
    target.isConnected &&
    !target.disabled &&
    !target.readOnly &&
    target.value === text &&
    readComposerEditor(target) === editor;
  const canUndo = () => committed === true && !used && targetMatches();
  return {
    value: text,
    committed,
    canUndo,
    undo(isCurrent = () => true) {
      if (!canUndo() || !isCurrent()) {
        return false;
      }
      used = true;
      focusComposerInput(target, { preventScroll: true });
      if (!targetMatches() || !isCurrent()) {
        return false;
      }
      if (editor) {
        editor.undo();
      } else {
        // Native history may be unavailable (the insertText fallback). Restore
        // only this verified field, never issue application-wide undo commands.
        target.setRangeText(before.value, 0, target.value.length, "end");
        target.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "historyUndo", data: null }),
        );
      }
      if (target.value !== before.value) {
        return undefined;
      }
      selectComposerInput(target, before.start, before.end, before.direction);
      return true;
    },
  };
}
