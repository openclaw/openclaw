import { vi } from "vitest";

/** jsdom has no editing engine; actual native undo is proved in the browser suite. */
export function installNativeTextEditing(document: Document) {
  const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: vi.fn((command: string, _showUi: boolean, text: string) => {
      if (command !== "insertText") {
        return false;
      }
      const input = document.activeElement;
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a focused native text editor");
      }
      if (!text && input.selectionStart === input.selectionEnd) {
        return true;
      }
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
      return true;
    }),
  });
  return () => {
    if (previous) {
      Object.defineProperty(document, "execCommand", previous);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
  };
}
