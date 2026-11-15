/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { TestConnection } from "./desktop-mobile-keyboard.test-support.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

describe("desktop mobile keyboard retention", () => {
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
});
