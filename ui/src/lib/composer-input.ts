/** Compatibility boundary for composer owners. Values and offsets remain raw text. */
export type ComposerEditorBridge = {
  element: HTMLElement;
  focusElement: HTMLElement;
  scrollElement: HTMLElement;
  coordsAtPos: (
    position: number,
  ) => { left: number; right: number; top: number; bottom: number } | null;
  isAtomicRange: (from: number, to: number) => boolean;
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
const activations = new WeakMap<HTMLTextAreaElement, () => void>();
/** Native fields still need to admit rich layout after an owner restores a draft. */
export function registerComposerActivation(input: HTMLTextAreaElement, activate: () => void) {
  activations.set(input, activate);
  return () => activations.delete(input);
}
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
  const editor = editors.get(input);
  if (editor) {
    editor.requestSync();
  } else {
    activations.get(input)?.();
  }
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
