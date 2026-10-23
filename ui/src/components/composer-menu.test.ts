// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { handleComposerMenuKeydown } from "./composer-menu.ts";

describe("composer suggestion completion", () => {
  it.each([0, 2])("leaves modified Tab to the browser with %i suggestions", (count) => {
    const menu = {
      count,
      index: 0,
      consumeEmpty: true,
      close: vi.fn(),
      move: vi.fn(),
      select: vi.fn(),
    };
    for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        cancelable: true,
        [modifier]: true,
      });
      expect(handleComposerMenuKeydown(event, menu)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(menu.select).not.toHaveBeenCalled();
    expect(menu.close).not.toHaveBeenCalled();
    expect(menu.move).not.toHaveBeenCalled();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    expect(handleComposerMenuKeydown(tab, menu)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(menu.select.mock.calls).toEqual(count ? [["Tab"]] : []);
  });
});
