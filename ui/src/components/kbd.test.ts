/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { renderKbd, renderKeyboardShortcut, renderShortcutText } from "./kbd.ts";

describe("shared keyboard hints", () => {
  it.each([
    [KEYBOARD_SHORTCUT_COMBOS.browserPanel, true, false, ["⌘⌥⇧U"], 3],
    [KEYBOARD_SHORTCUT_COMBOS.browserPanel, false, false, ["Ctrl+Alt+Shift+U"], 0],
    [KEYBOARD_SHORTCUT_COMBOS.newline, true, true, ["⇧", "⏎"], 2],
  ] as const)(
    "renders platform labels and keycaps for %j (Apple: %s, separate: %s)",
    (combo, applePlatform, separateKeys, labels, iconCount) => {
      const host = document.createElement("div");
      render(renderKeyboardShortcut(combo, { applePlatform, separateKeys }), host);
      const keys = host.querySelectorAll("kbd");
      expect(keys).toHaveLength(labels.length);
      if (separateKeys) {
        expect(Array.from(keys, (key) => key.textContent?.trim())).toEqual(labels);
      }
      expect(host.querySelectorAll("svg")).toHaveLength(iconCount);
      expect(applePlatform ? host.textContent?.replace(/\s+/gu, "") : host.textContent).toBe(
        labels.join(""),
      );
      for (const icon of host.querySelectorAll("svg")) {
        expect(icon.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
        expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
      }
      for (const symbol of host.querySelectorAll(".kbd__symbol")) {
        expect(symbol.closest('[aria-hidden="true"]')).toBeNull();
      }
    },
  );

  it("preserves caller slots, hidden state, literal labels and translated placement", () => {
    const host = document.createElement("div");
    render(
      renderKbd("constructor", {
        className: "session-menu__shortcut",
        slot: "details",
        hidden: true,
        ariaHidden: true,
      }),
      host,
    );
    const key = host.querySelector("kbd")!;
    expect(key.textContent).toBe("constructor");
    expect(key.hidden).toBe(true);
    expect(key.slot).toBe("details");
    expect(key.getAttribute("aria-hidden")).toBe("true");
    render(renderShortcutText("{shortcut} first; {shortcut} again", renderKbd("/")), host);
    expect(host.textContent).toBe("/ first; / again");
    expect(host.querySelectorAll("kbd")).toHaveLength(2);
  });
});
