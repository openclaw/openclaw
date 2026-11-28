import {
  focusComposerInput,
  readComposerEditor,
  readComposerNativeEditMetadata,
  selectComposerInput,
} from "./composer-input.ts";

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
  const captureMetadata = range && !editor ? readComposerNativeEditMetadata(target) : undefined;
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
    (editor !== undefined || !range || readComposerNativeEditMetadata(target) === captureMetadata);
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
