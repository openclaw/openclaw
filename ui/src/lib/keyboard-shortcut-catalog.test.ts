/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
  formatKeyboardShortcutParts,
} from "./keyboard-shortcut-contract.ts";

const keydown = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
const combos = KEYBOARD_SHORTCUT_COMBOS;
const matches = (id: keyof typeof combos, init: KeyboardEventInit) =>
  matchesShortcutCombo(combos[id], keydown(init));

describe("keyboard shortcut catalog matching", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["MacIntel", "Win32"])(
    "matches direct session shortcuts exactly on %s without taking New Window",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      for (const combo of [combos.newSession, combos.archiveSession]) {
        const init = {
          key: combo.key.toUpperCase(),
          code: `Key${combo.key.toUpperCase()}`,
          shiftKey: true,
          ...modifier,
        };
        expect(matchesShortcutCombo(combo, keydown(init))).toBe(true);
        for (const changes of [
          { shiftKey: false },
          { altKey: true },
          { metaKey: true, ctrlKey: true },
          { key: "Dead" },
          { isComposing: true },
          { keyCode: 229 },
          { key: "n", code: "KeyN" },
        ]) {
          expect(matchesShortcutCombo(combo, keydown({ ...init, ...changes }))).toBe(false);
        }
        expect(matchesShortcutCombo(combo, keydown({ ...init, key: "ж" }))).toBe(true);
      }
    },
  );
  it.each(["MacIntel", "Win32"])(
    "accepts the primary modifier and non-Latin physical letters on %s",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const modifiers = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      const event = keydown({ key: "л", code: "KeyK", ...modifiers });

      expect(isCommandPaletteShortcut(event)).toBe(true);
    },
  );

  it.each([
    { metaKey: true, ctrlKey: true },
    { metaKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true },
  ])("rejects extra modifiers %j", (modifiers) => {
    const event = keydown({ key: "k", code: "KeyK", ...modifiers });

    expect(isCommandPaletteShortcut(event)).toBe(false);
  });

  it.each([
    ["/", "Digit7", true],
    ["?", "Slash", true],
    ["/", "Slash", false],
    ["ظ", "Slash", false],
  ] as const)("opens the overview with %s on %s (Shift=%s)", (key, code, shiftKey) => {
    expect(matches("keyboardShortcuts", { key, code, shiftKey, ctrlKey: true })).toBe(true);
  });

  it("leaves Latin layouts that put another printable on the Slash key alone", () => {
    expect(matches("keyboardShortcuts", { key: "-", code: "Slash", metaKey: true })).toBe(false);
  });

  it.each([
    [{ key: "ö" }, true],
    [{ key: "~", shiftKey: true }, true],
    [{ altKey: true }, false],
  ] as const)("matches physical Backquote with %j: %s", (keys, expected) => {
    expect(isTerminalPanelShortcut(keydown({ code: "Backquote", ctrlKey: true, ...keys }))).toBe(
      expected,
    );
  });
  it("matches physical Comma independently of its produced character", () => {
    expect(
      matches("appearanceSettings", { key: "<", code: "Comma", metaKey: true, shiftKey: true }),
    ).toBe(true);
  });
});

describe("keyboard shortcut catalog presentation", () => {
  it.each([
    ["debugOverlay", true, ["⌘", "⇧", "D"]],
    ["debugOverlay", false, ["Ctrl", "Shift", "D"]],
    ["terminalPanel", true, ["⌃", "`"]],
    ["approveAlways", false, ["Ctrl", "Shift", "Enter"]],
    ["escape", true, ["esc"]],
    ["historyPrevious", true, ["↑"]],
    ["toggleSessionSelect", true, ["⌥", "Click"]],
    ["toggleSessionSelect", false, ["Alt", "Click"]],
    ["extendSessionSelect", false, ["Shift", "Click"]],
    ["zoomIn", false, ["+"]],
    ["zoomReset", true, ["0"]],
  ] as const)("formats %s with Apple platform=%s", (id, apple, expected) => {
    expect(formatKeyboardShortcutParts(combos[id], apple)).toEqual(expected);
  });

  it("gives every built-in shortcut a unique chord", () => {
    const chords = Object.values(combos).map((combo) =>
      JSON.stringify(formatKeyboardShortcutParts(combo, true)),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });

  it.each([
    ["browserPanel", "KeyU"],
    ["desktopPanel", "KeyD"],
    ["discussionPanel", "KeyJ"],
    ["dashboardPanel", "KeyG"],
    ["reviewPanel", "KeyE"],
  ] as const)("matches %s on a non-Latin keyboard", (id, code) => {
    expect(matches(id, { key: "¨", code, metaKey: true, altKey: true, shiftKey: true })).toBe(true);
  });
});
