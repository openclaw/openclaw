/** Compatibility boundary for composer owners. Values and offsets remain raw text. */
export type ComposerEditorBridge = {
  element: HTMLElement;
  focusElement: HTMLElement;
  scrollElement: HTMLElement;
  coordsAtPos: (
    position: number,
  ) => { left: number; right: number; top: number; bottom: number } | null;
  sync: () => void;
  focus: (options?: FocusOptions) => void;
  select: (start: number, end: number, direction?: "forward" | "backward" | "none") => void;
  replace: (text: string, start: number, end: number) => void;
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
const scheduled = new WeakSet<ComposerEditorBridge>();
export function syncComposerInput(input: HTMLTextAreaElement) {
  const editor = editors.get(input);
  if (!editor || scheduled.has(editor)) {
    return;
  }
  scheduled.add(editor);
  // Controlled-value writers run in Solid effects. Let the foreign renderer
  // reconcile after that commit, outside the Solid computation/apply phase.
  queueMicrotask(() => {
    scheduled.delete(editor);
    if (editors.get(input) === editor) {
      editor.sync();
    }
  });
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
export function replaceComposerInput(
  input: HTMLTextAreaElement,
  text: string,
  start: number,
  end: number,
) {
  const editor = editors.get(input);
  if (editor) {
    editor.replace(text, start, end);
  } else {
    input.setRangeText(text, start, end, "end");
  }
}
