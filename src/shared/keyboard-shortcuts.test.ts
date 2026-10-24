import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createKeyboardShortcutMatcher } from "./keyboard-shortcuts.js";

describe("serialized keyboard shortcut matcher", () => {
  it("preserves native Unicode and shortcut matching after widget prototype changes", () => {
    const result: unknown = runInNewContext(`
      const matcher = (${createKeyboardShortcutMatcher.toString()})();
      const event = (key, code, overrides = {}) => ({
        key, code, keyCode: 0, isComposing: false,
        metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
        ...overrides,
      });
      const check = () => [
        matcher.isApplePlatform("MacIntel"),
        matcher.isApplePlatform("Linux"),
        matcher.resolveAsciiShortcutKey(event("K", "KeyQ")),
        matcher.resolveAsciiShortcutKey(event("л", "KeyK")),
        matcher.resolveAsciiShortcutKey(event("😀", "KeyA")),
        matcher.resolveAsciiShortcutKey(event("\\uD800", "KeyB")),
        matcher.resolveAsciiShortcutKey(event("٢", "Digit2")),
        matcher.resolveAsciiShortcutKey(event("Dead", "KeyE")),
        matcher.matchesKeyboardShortcut(
          { modifiers: ["mod"], key: "k", platformSpecific: true },
          event("k", "KeyK"), true, "k",
        ),
        matcher.matchesKeyboardShortcut(
          { modifiers: ["mod", "alt"], key: "ß" },
          event("Dead", "KeySS", { altKey: true }), true, null,
        ),
        matcher.matchesKeyboardShortcut(
          { modifiers: ["mod", "alt"], key: "ß" },
          event("∂", "KeySS", { altKey: true }), true, null,
        ),
        matcher.matchesKeyboardShortcut(
          { modifiers: ["mod"], key: "/" },
          event("ж", "Slash"), true, null,
        ),
        matcher.matchesKeyboardShortcut(
          { modifiers: ["mod"], key: "/" },
          event("-", "Slash"), true, null,
        ),
      ];
      const before = check();
      const poisoned = () => { throw new Error("widget-owned prototype used"); };
      String.prototype.toLowerCase = poisoned;
      String.prototype.toUpperCase = poisoned;
      String.prototype.codePointAt = poisoned;
      RegExp.prototype.exec = poisoned;
      Array.prototype.includes = poisoned;
      Object.prototype[Symbol.toPrimitive] = poisoned;
      ({ before, after: check() });
    `);
    const expected = [true, false, "k", "k", "a", "b", "2", null, true, false, true, true, false];
    expect(result).toEqual({ before: expected, after: expected });
  });
});
