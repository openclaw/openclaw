/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { recordCompositionEnd } from "../../lib/ime.ts";
import { TestConnection } from "./desktop-mobile-keyboard.test-support.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

function createKeyboard() {
  const connection = new TestConnection();
  const input = document.createElement("textarea");
  const [keyboard, dispose] = createRoot(
    (disposeRoot) => [createDesktopMobileKeyboard(() => connection), disposeRoot] as const,
  );
  flush();
  keyboard.inputRef(input);
  // The document view installs these through Solid JSX; the bare field here needs them too.
  input.addEventListener("keydown", (event) => keyboard.handleKeyboardEvent(event));
  input.addEventListener("keyup", (event) => keyboard.handleKeyboardEvent(event));
  // Mirrors the compositionend wiring the document view installs on this field.
  input.addEventListener("compositionend", recordCompositionEnd);
  return { connection, input, keyboard, dispose };
}

describe("desktop mobile keyboard", () => {
  it("keeps held modifiers when refilling the active input", () => {
    const { connection, input, keyboard, dispose } = createKeyboard();
    input.addEventListener("input", (event) => keyboard.handleInput(event as InputEvent));
    try {
      keyboard.handleKeyboardEvent(
        new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }),
      );
      keyboard.reset(input);
      input.value += "p";
      input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: "p" }));

      expect(connection.events).toEqual([
        "keydown:ShiftLeft",
        "keyup:ShiftLeft",
        "text:p",
        "keydown:ShiftLeft",
      ]);
    } finally {
      dispose();
    }
  });

  it("keeps a composing keydown off the wire while releases and shortcuts stay on it", () => {
    const { connection, input, dispose } = createKeyboard();
    const key = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
      input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    try {
      // Chrome keeps isComposing set on the keydown that confirms the candidate. Its
      // release still goes out: noVNC drops a release whose keydown it never saw.
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      key("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
      expect(connection.events).toEqual([]);
      key("keyup", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
      expect(connection.events).toEqual(["keyup:Enter"]);

      // WebKit clears both flags before the Enter that commits the composition.
      connection.events.length = 0;
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      key("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
      expect(connection.events).toEqual([]);
      key("keyup", { key: "Enter", code: "Enter", keyCode: 13 });
      expect(connection.events).toEqual(["keyup:Enter"]);

      // A shortcut released mid-composition keeps its keyup: the chord keydown already went
      // out, so dropping the ArrowLeft release would hold that key on the remote.
      connection.events.length = 0;
      key("keyup", { key: "ArrowLeft", code: "ArrowLeft", isComposing: true });
      expect(connection.events).toEqual(["keyup:ArrowLeft"]);

      // An ordinary Enter is untouched on both edges.
      connection.events.length = 0;
      key("keydown", { key: "Enter", code: "Enter", keyCode: 13 });
      key("keyup", { key: "Enter", code: "Enter", keyCode: 13 });
      expect(connection.events).toEqual(["keydown:Enter", "keyup:Enter"]);
    } finally {
      dispose();
    }
  });
});
