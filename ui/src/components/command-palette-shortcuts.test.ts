/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  createContext,
  createGateway,
  mountPalette,
  registerCommandPaletteTestHooks,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette platform shortcuts", () => {
  registerCommandPaletteTestHooks();

  it.each(["MacIntel", "Linux x86_64"])(
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
      const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      const start = palette.querySelector<HTMLButtonElement>(
        ".cmd-palette__input-actions .cmd-palette__create",
      )!;
      expect(start.disabled).toBe(true);
      expect(start.hidden).toBe(false);
      expect(start.textContent).toContain("New session");
      expect(start.querySelector("kbd")?.textContent?.replace(/\s+/gu, "").trim()).toBe(
        platform === "MacIntel" ? "⌘⏎" : "Ctrl+Enter",
      );
      expect(start.querySelectorAll("kbd svg")).toHaveLength(platform === "MacIntel" ? 2 : 0);
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
