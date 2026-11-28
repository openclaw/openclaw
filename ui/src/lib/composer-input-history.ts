import {
  canReplaceComposerInputWithHistory,
  focusComposerInput,
  readComposerEditor,
} from "./composer-input.ts";

/** Replace the captured range once; `text` is the complete resulting draft.
 * Undefined means the effect cannot be confirmed. Never retries. */
export function replaceComposerInputWithHistory(
  input: HTMLTextAreaElement,
  text: string,
  isCurrent: () => boolean,
  range: { start: number; end: number },
): boolean | undefined {
  if (!canReplaceComposerInputWithHistory(input)) {
    return false;
  }
  focusComposerInput(input, { preventScroll: true });
  // Focusing/syncing can synchronously run another owner's draft or cancellation handler.
  if (!isCurrent()) {
    return false;
  }
  const previous = input.value;
  const replacement = text.slice(range.start, text.length - (previous.length - range.end));
  const editor = readComposerEditor(input);
  if (editor) {
    editor.replace(replacement, range.start, range.end, { isolateHistory: true });
    return input.value === text ? true : undefined;
  }
  input.setSelectionRange(range.start, range.end);
  const reported = input.ownerDocument.execCommand("insertText", false, replacement);
  return reported && input.value === text
    ? true
    : !reported && input.value === previous
      ? false
      : undefined;
}
