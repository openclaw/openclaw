/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

class TestConnection implements DesktopConnectionHandle {
  readonly events: string[] = [];
  disconnect() {}
  disableInput() {}
  setPresented() {
    return true;
  }
  sendBackspace() {
    this.events.push("backspace");
  }
  sendKeyboardEvent(event: KeyboardEvent) {
    this.events.push(`${event.type}:${event.code}`);
  }
  sendText(text: string) {
    this.events.push(`text:${text}`);
  }
  setSizingMode() {}
}

describe("desktop mobile keyboard", () => {
  it.each(["reset", "dispose"] as const)(
    "releases held modifiers and the previous connection on %s without another event",
    async (release) => {
      const createHandoff = () => {
        let connection = new TestConnection();
        let controlling = true;
        const [keyboard, dispose] = createRoot(
          (disposeRoot) =>
            [
              createDesktopMobileKeyboard(() => (controlling ? connection : null)),
              disposeRoot,
            ] as const,
        );
        flush();
        keyboard.handleKeyboardEvent(
          new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }),
        );
        const previous = new WeakRef(connection);
        connection = new TestConnection();
        controlling = false;
        if (release === "reset") {
          keyboard.reset();
        } else {
          dispose();
        }
        return { keyboard, dispose, previous, replacement: connection };
      };
      const { keyboard, dispose, previous, replacement } = createHandoff();
      const unowned = new WeakRef(new TestConnection());

      await collectGarbageForTest();

      expect(unowned.deref()).toBeUndefined();
      expect(previous.deref()).toBeUndefined();
      expect(replacement).toBeInstanceOf(TestConnection);
      keyboard.reset();
      dispose();
    },
  );

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
