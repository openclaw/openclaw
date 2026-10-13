/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";
import { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

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

describe("DesktopMobileKeyboard", () => {
  it("releases the previous connection on full reset without another keyboard event", async () => {
    const createHandoff = () => {
      let connection = new TestConnection();
      let controlling = true;
      const keyboard = new DesktopMobileKeyboard({
        connection: () => connection,
        controlling: () => controlling,
        input: () => null,
      });
      keyboard.focus();
      const previous = new WeakRef(connection);
      connection = new TestConnection();
      controlling = false;
      keyboard.reset();
      return { keyboard, previous, replacement: connection };
    };
    const { keyboard, previous, replacement } = createHandoff();
    const unowned = new WeakRef(new TestConnection());

    await collectGarbageForTest();

    expect(unowned.deref()).toBeUndefined();
    expect(previous.deref()).toBeUndefined();
    expect(replacement).toBeInstanceOf(TestConnection);
    expect(keyboard).toBeInstanceOf(DesktopMobileKeyboard);
  });

  it("keeps held modifiers when refilling the active input", () => {
    const connection = new TestConnection();
    const input = document.createElement("textarea");
    const keyboard = new DesktopMobileKeyboard({
      connection: () => connection,
      controlling: () => true,
      input: () => input,
    });
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
      keyboard.reset();
    }
  });
});
