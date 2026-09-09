/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { createContext, createGateway, mountPalette } from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette platform shortcuts", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "uses the platform palette shortcut on %s without consuming text editing",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const { gateway } = createGateway(true);
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => null),
        ),
      );
      const editor = document.body.appendChild(document.createElement("textarea"));
      editor.focus();
      const primary = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      const other = platform === "MacIntel" ? { ctrlKey: true } : { metaKey: true };
      const chord = (modifiers: KeyboardEventInit) =>
        new KeyboardEvent("keydown", {
          key: "л",
          code: "KeyK",
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });

      const nativeEdit = chord(other);
      editor.dispatchEvent(nativeEdit);
      expect(nativeEdit.defaultPrevented).toBe(false);
      expect(palette.isOpen).toBe(false);
      expect(document.activeElement).toBe(editor);

      const open = chord(primary);
      editor.dispatchEvent(open);
      await palette.updateComplete;
      expect(open.defaultPrevented).toBe(true);
      expect(palette.isOpen).toBe(true);
      const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input")!;
      const editQuery = chord(other);
      input.dispatchEvent(editQuery);
      expect(editQuery.defaultPrevented).toBe(false);
      expect(palette.isOpen).toBe(true);

      const close = chord(primary);
      input.dispatchEvent(close);
      await palette.updateComplete;
      expect(close.defaultPrevented).toBe(true);
      expect(palette.isOpen).toBe(false);
    },
  );
});
