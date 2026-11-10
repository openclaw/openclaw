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

  it("keeps a composing Enter off the wire while a plain Enter still reaches the remote", () => {
    const { connection, input, dispose } = createKeyboard();
    const press = (init: KeyboardEventInit) => {
      for (const type of ["keydown", "keyup"] as const) {
        input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
      }
    };
    try {
      // Chrome keeps isComposing set on the keydown that confirms the candidate.
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      press({ key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
      expect(connection.events).toEqual([]);

      // WebKit clears both flags before the Enter that commits the composition.
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      press({ key: "Enter", code: "Enter", keyCode: 13 });
      expect(connection.events).toEqual([]);

      press({ key: "Enter", code: "Enter", keyCode: 13 });
      expect(connection.events).toEqual(["keydown:Enter", "keyup:Enter"]);
    } finally {
      dispose();
    }
  });
});
