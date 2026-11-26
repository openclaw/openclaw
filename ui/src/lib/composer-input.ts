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
  replace: (
    text: string,
    start: number,
    end: number,
    options?: { isolateHistory?: boolean },
  ) => void;
  /** Replace the whole draft as one isolated history step. */
  replaceAll: (text: string) => void;
  /** Step the editor's own history back, restoring mention identities with the text. */
  undo: () => void;
};
const editors = new WeakMap<HTMLTextAreaElement, ComposerEditorBridge>();
type ComposerNativeEditMetadata = (edit: {
  before: string;
  after: string;
  start: number;
  end: number;
}) => { write: (run: () => void) => void; undo: (run: () => void) => void };
const nativeEditMetadata = new WeakMap<HTMLTextAreaElement, ComposerNativeEditMetadata>();

/** Feature bindings keep their own metadata beside synchronous native edits. */
export function registerComposerNativeEditMetadata(
  input: HTMLTextAreaElement,
  capture: ComposerNativeEditMetadata,
) {
  nativeEditMetadata.set(input, capture);
  return () => {
    if (nativeEditMetadata.get(input) === capture) {
      nativeEditMetadata.delete(input);
    }
  };
}

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
  range?: { start: number; end: number; caret: number },
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
    (isCurrent &&
      (!isCurrent() ||
        target.value !== before.value ||
        readComposerEditor(target) !== editor ||
        target.disabled ||
        target.readOnly)) ||
    (range && before.value === text)
  ) {
    return { value: text, committed: false, canUndo: () => false, undo: () => false };
  }
  const start = range ? Math.max(0, Math.min(range.start, before.value.length)) : 0;
  const end = range
    ? Math.max(start, Math.min(range.end, before.value.length))
    : before.value.length;
  // The insertion owner supplies the admitted source range and resulting caret.
  // Its joined text includes any separators without inferring a diff from labels.
  const inserted = range ? text.slice(start, range.caret) : text;
  const captureMetadata = range && !editor ? nativeEditMetadata.get(target) : undefined;
  const metadata = captureMetadata?.({ before: before.value, after: text, start, end });
  if (editor) {
    if (range) {
      editor.replace(inserted, start, end, { isolateHistory: true });
    } else {
      editor.replaceAll(text);
    }
  } else {
    const write = () => {
      target.setSelectionRange(start, range ? end : target.value.length);
      if (!target.ownerDocument.execCommand?.("insertText", false, inserted)) {
        target.setRangeText(inserted, start, range ? end : target.value.length, "end");
        target.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: inserted }),
        );
      }
    };
    if (metadata) {
      metadata.write(write);
    } else {
      write();
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
    readComposerEditor(target) === editor &&
    (editor !== undefined || !range || nativeEditMetadata.get(target) === captureMetadata);
  const canUndo = () => committed === true && !used && targetMatches();
  return {
    value: text,
    committed,
    canUndo,
    undo(isUndoCurrent = () => true) {
      if (!canUndo() || !isUndoCurrent()) {
        return false;
      }
      used = true;
      focusComposerInput(target, { preventScroll: true });
      if (!targetMatches() || !isUndoCurrent()) {
        return false;
      }
      if (editor) {
        editor.undo();
      } else {
        // Native history may be unavailable (the insertText fallback). Restore
        // only this verified field, never issue application-wide undo commands.
        const restore = () => {
          target.setRangeText(before.value, 0, target.value.length, "end");
          target.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "historyUndo", data: null }),
          );
        };
        if (metadata) {
          metadata.undo(restore);
        } else {
          restore();
        }
      }
      if (target.value !== before.value) {
        return undefined;
      }
      selectComposerInput(target, before.start, before.end, before.direction);
      return true;
    },
  };
}
