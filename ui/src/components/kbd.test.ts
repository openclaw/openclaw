/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { renderKbd, renderKeyboardShortcut, renderShortcutText } from "./kbd.ts";

describe("shared keyboard hints", () => {
  it("renders Apple modifiers as real SVG and retains the original platform shortcut text", () => {
    const host = document.createElement("div");
    render(
      renderKeyboardShortcut(KEYBOARD_SHORTCUT_COMBOS.browserPanel, { applePlatform: true }),
      host,
    );
    expect(host.querySelectorAll("kbd")).toHaveLength(1);
    expect(host.querySelectorAll("svg")).toHaveLength(3);
    expect(host.textContent?.replace(/\s+/gu, "")).toBe("⌘⌥⇧U");
    for (const icon of host.querySelectorAll("svg")) {
      expect(icon.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    for (const symbol of host.querySelectorAll(".kbd__symbol")) {
      expect(symbol.closest('[aria-hidden="true"]')).toBeNull();
    }
  });

  it("keeps non-Apple labels and separate keycap grouping", () => {
    const host = document.createElement("div");
    render(
      renderKeyboardShortcut(KEYBOARD_SHORTCUT_COMBOS.browserPanel, { applePlatform: false }),
      host,
    );
    expect(host.textContent).toBe("Ctrl+Alt+Shift+U");
    expect(host.querySelector("svg")).toBeNull();
    render(
      renderKeyboardShortcut(KEYBOARD_SHORTCUT_COMBOS.newline, {
        applePlatform: true,
        separateKeys: true,
      }),
      host,
    );
    expect(Array.from(host.querySelectorAll("kbd"), (key) => key.textContent?.trim())).toEqual([
      "⇧",
      "⏎",
    ]);
  });

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
