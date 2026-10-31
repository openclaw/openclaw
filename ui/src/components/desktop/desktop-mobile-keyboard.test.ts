/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { TestConnection } from "./desktop-mobile-keyboard.test-support.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

describe("desktop mobile keyboard", () => {
  it("keeps held modifiers when refilling the active input", () => {
    const connection = new TestConnection();
    const input = document.createElement("textarea");
    const [keyboard, dispose] = createRoot(
      (disposeRoot) => [createDesktopMobileKeyboard(() => connection), disposeRoot] as const,
    );
    flush();
    keyboard.inputRef(input);
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
});
