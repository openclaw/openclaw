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
