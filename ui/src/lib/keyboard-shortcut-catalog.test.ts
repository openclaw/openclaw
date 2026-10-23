/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import { resolveKeyboardShortcutSections } from "./keyboard-shortcut-catalog.ts";
import {
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
  formatKeyboardShortcutParts,
} from "./keyboard-shortcut-contract.ts";

describe("keyboard shortcut catalog matching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each([false, true])("shows the New Session chord for native=%s", (native) => {
    vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", native);
    for (const preference of ["enter", "modifier-enter"] as const) {
      const entry = resolveKeyboardShortcutSections(preference)
        .flatMap((section) => section.entries)
        .find((candidate) => candidate.id === "newSession")!;
      expect(entry.combos.map((combo) => formatKeyboardShortcutParts(combo, true))).toEqual([
        native ? ["⌘", "N"] : ["⌘", "⇧", "O"],
      ]);
      expect(entry.combos.map((combo) => formatKeyboardShortcutParts(combo, false))).toEqual([
        native ? ["Ctrl", "N"] : ["Ctrl", "Shift", "O"],
      ]);
    }
  });
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "matches direct session shortcuts exactly on %s without taking New Window",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      for (const combo of [
        KEYBOARD_SHORTCUT_COMBOS.newSession,
        KEYBOARD_SHORTCUT_COMBOS.archiveSession,
      ]) {
        const init = {
          key: combo.key.toUpperCase(),
          code: `Key${combo.key.toUpperCase()}`,
          shiftKey: true,
          ...modifier,
        };
        expect(matchesShortcutCombo(combo, new KeyboardEvent("keydown", init))).toBe(true);
        for (const changes of [
          { shiftKey: false },
          { altKey: true },
          { metaKey: true, ctrlKey: true },
          { key: "Dead" },
          { isComposing: true },
          { keyCode: 229 },
          { key: "n", code: "KeyN" },
        ]) {
          expect(
            matchesShortcutCombo(combo, new KeyboardEvent("keydown", { ...init, ...changes })),
          ).toBe(false);
        }
        expect(
          matchesShortcutCombo(combo, new KeyboardEvent("keydown", { ...init, key: "ж" })),
        ).toBe(true);
      }
    },
  );
  it.each([
    { name: "Command", platform: "MacIntel", modifiers: { metaKey: true } },
    { name: "Control", platform: "Win32", modifiers: { ctrlKey: true } },
  ])(
    "accepts the $name primary modifier and non-Latin physical letters",
    ({ platform, modifiers }) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const event = new KeyboardEvent("keydown", { key: "л", code: "KeyK", ...modifiers });

      expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event)).toBe(true);
      expect(isCommandPaletteShortcut(event)).toBe(true);
    },
  );

  it.each([
    { name: "both primary modifiers", modifiers: { metaKey: true, ctrlKey: true } },
    { name: "an extra Shift modifier", modifiers: { metaKey: true, shiftKey: true } },
    { name: "an extra Alt modifier", modifiers: { ctrlKey: true, altKey: true } },
  ])("rejects $name for an exact primary-modifier chord", ({ modifiers }) => {
    const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ...modifiers });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette, event)).toBe(false);
    expect(isCommandPaletteShortcut(event)).toBe(false);
  });

  it.each([
    { name: "the slash character", key: "/", code: "Digit7", shiftKey: true },
    { name: "the physical slash key", key: "?", code: "Slash", shiftKey: true },
    { name: "an unshifted slash", key: "/", code: "Slash", shiftKey: false },
    { name: "a non-Latin physical slash key", key: "ظ", code: "Slash", shiftKey: false },
  ])("opens the overview with $name regardless of layout-required Shift", (keyboard) => {
    const event = new KeyboardEvent("keydown", { ...keyboard, ctrlKey: true });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, event)).toBe(true);
  });

  it("leaves Latin layouts that put another printable on the Slash key alone", () => {
    // German: physical Slash produces "-", so Ctrl/Cmd+"-" must stay browser zoom.
    const zoomOut = new KeyboardEvent("keydown", { key: "-", code: "Slash", metaKey: true });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, zoomOut)).toBe(false);
  });

  it.each([
    { name: "a dead key", keyboard: { key: "Dead" } },
    { name: "active composition", keyboard: { key: "U", isComposing: true } },
    { name: "an IME key event", keyboard: { key: "U", keyCode: 229 } },
  ])("does not match $name for either primary modifier", ({ keyboard }) => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(
        matchesShortcutCombo(
          KEYBOARD_SHORTCUT_COMBOS.browserPanel,
          new KeyboardEvent("keydown", {
            code: "KeyU",
            altKey: true,
            shiftKey: true,
            ...modifier,
            ...keyboard,
          }),
        ),
      ).toBe(false);
    }
  });

  it("matches physical Backquote and Comma keys independently of their produced characters", () => {
    const terminal = new KeyboardEvent("keydown", {
      key: "ö",
      code: "Backquote",
      ctrlKey: true,
    });
    const appearance = new KeyboardEvent("keydown", {
      key: "<",
      code: "Comma",
      metaKey: true,
      shiftKey: true,
    });

    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.terminalPanel, terminal)).toBe(true);
    expect(isTerminalPanelShortcut(terminal)).toBe(true);
    // Shipped contract: Ctrl+Shift+Backquote still toggles the terminal
    // (layouts where the Backquote key is shifted must keep working).
    expect(
      isTerminalPanelShortcut(
        new KeyboardEvent("keydown", {
          key: "~",
          code: "Backquote",
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(true);
    expect(matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings, appearance)).toBe(
      true,
    );
    expect(
      isTerminalPanelShortcut(
        new KeyboardEvent("keydown", { code: "Backquote", ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
  });
});

describe("keyboard shortcut catalog presentation", () => {
  it("uses Apple glyph chips and readable non-Apple modifier chips", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, true)).toEqual([
      "⌘",
      "⇧",
      "D",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, false)).toEqual([
      "Ctrl",
      "Shift",
      "D",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.terminalPanel, true)).toEqual([
      "⌃",
      "`",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.approveAlways, false)).toEqual([
      "Ctrl",
      "Shift",
      "Enter",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.escape, true)).toEqual(["esc"]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.historyPrevious, true)).toEqual([
      "↑",
    ]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.toggleSessionSelect, true)).toEqual(
      ["⌥", "Click"],
    );
    expect(
      formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.toggleSessionSelect, false),
    ).toEqual(["Alt", "Click"]);
    expect(
      formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.extendSessionSelect, false),
    ).toEqual(["Shift", "Click"]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.zoomIn, false)).toEqual(["+"]);
    expect(formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.zoomReset, true)).toEqual(["0"]);
  });

  it("swaps both send-preference chords when the composer preference is modifier-enter", () => {
    const entryCombos = (id: string) =>
      resolveKeyboardShortcutSections("modifier-enter")
        .flatMap((section) => section.entries)
        .find((entry) => entry.id === id)?.combos;

    expect(entryCombos("startNewSession")).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
    expect(entryCombos("sendMessage")).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
  });

  it("derives the displayed send chord from the composer's active preference", () => {
    const sendEntry = (preference: "enter" | "modifier-enter") =>
      resolveKeyboardShortcutSections(preference)
        .find((section) => section.id === "chat")
        ?.entries.find((entry) => entry.id === "sendMessage");

    expect(sendEntry("enter")?.combos).toEqual([KEYBOARD_SHORTCUT_COMBOS.sendMessage]);
    expect(sendEntry("modifier-enter")?.combos).toEqual([KEYBOARD_SHORTCUT_COMBOS.modifiedEnter]);
  });

  it("lists every built-in panel with a unique chord", () => {
    const panels = resolveKeyboardShortcutSections().find((section) => section.id === "panels")!;
    const expected = {
      terminalPanel: [["⌃", "`"]],
      homePanel: [["⌘", "⇧", "H"]],
      workspaceFiles: [["⌘", "⇧", "B"]],
      sideChat: [["⌘", "⇧", "S"]],
      browserPanel: [["⌘", "⌥", "⇧", "U"]],
      desktopPanel: [["⌘", "⌥", "⇧", "D"]],
      discussionPanel: [["⌘", "⌥", "⇧", "J"]],
      dashboardPanel: [["⌘", "⌥", "⇧", "G"]],
      reviewPanel: [["⌘", "⌥", "⇧", "E"]],
    };
    expect(
      Object.fromEntries(
        panels.entries.map((entry) => [
          entry.id,
          entry.combos.map((combo) => formatKeyboardShortcutParts(combo, true)),
        ]),
      ),
    ).toEqual(expected);
    const combos = Object.values(KEYBOARD_SHORTCUT_COMBOS).map((combo) =>
      JSON.stringify(formatKeyboardShortcutParts(combo, true)),
    );
    expect(new Set(combos).size).toBe(combos.length);
    for (const entry of panels.entries) {
      for (const combo of entry.combos.filter((candidate) => candidate.modifiers.includes("alt"))) {
        expect(
          matchesShortcutCombo(
            combo,
            new KeyboardEvent("keydown", {
              key: "¨",
              code: `Key${combo.key.toUpperCase()}`,
              metaKey: true,
              altKey: true,
              shiftKey: true,
            }),
          ),
          entry.id,
        ).toBe(true);
      }
    }
  });

  it("gives every section and shortcut a resolvable label and at least one real chord", () => {
    for (const section of resolveKeyboardShortcutSections()) {
      expect(t(section.label), section.label).not.toBe(section.label);
      for (const entry of section.entries) {
        expect(t(entry.label), entry.label).not.toBe(entry.label);
        expect(entry.combos.length, entry.id).toBeGreaterThan(0);
      }
    }
  });
});

it("shows mobile Return as newline and omits composer submission chords", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  try {
    const entries = resolveKeyboardShortcutSections("modifier-enter").flatMap(
      (section) => section.entries,
    );
    expect(entries.find((entry) => entry.id === "newline")?.combos).toEqual([
      KEYBOARD_SHORTCUT_COMBOS.sendMessage,
    ]);
    for (const id of [
      "sendMessage",
      "paletteStartSession",
      "startNewSession",
      "steerImmediately",
      "saveQueuedMessage",
    ]) {
      expect(entries.find((entry) => entry.id === id)).toBeUndefined();
    }
  } finally {
    vi.restoreAllMocks();
  }
});
