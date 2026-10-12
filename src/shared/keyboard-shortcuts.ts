export type KeyboardShortcutModifier = "mod" | "ctrl" | "shift" | "alt";
export type KeyboardShortcutDefinition<Key extends string = string> = {
  readonly modifiers: readonly KeyboardShortcutModifier[];
  readonly key: Key;
  readonly platformSpecific?: boolean;
};

type KeyboardShortcutEvent = {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

export const COMMAND_PALETTE_SHORTCUT = {
  modifiers: ["mod"],
  key: "k",
  platformSpecific: true,
} as const satisfies KeyboardShortcutDefinition;

// Serialized into sandbox documents before widget scripts run. Object methods
// keep the factory self-contained through bundling, with pristine operations
// captured once so widget prototype changes cannot redefine a host shortcut.
export function createKeyboardShortcutMatcher() {
  // A private receiver keeps String intrinsics bound without consulting widget-
  // mutable prototypes. Conversion is synchronous and returns only our string.
  const text = {
    value: "",
    [Symbol.toPrimitive]() {
      return this.value;
    },
  };
  const lowerText = String.prototype.toLowerCase.bind(text);
  const upperText = String.prototype.toUpperCase.bind(text);
  const textCodePointAt = String.prototype.codePointAt.bind(text);
  const strings = {
    lower(value: string) {
      text.value = value;
      return lowerText();
    },
    upper(value: string) {
      text.value = value;
      return upperText();
    },
    codePointAt(value: string, position: number) {
      text.value = value;
      return textCodePointAt(position);
    },
  };
  const patterns = {
    apple: /Mac|iPhone|iPad|iPod/u,
    asciiKey: /^[a-z0-9]$/,
    letterCode: /^Key([A-Z])$/,
    digitCode: /^Digit([0-9])$/,
    printableAscii: /^[\x20-\x7e]$/u,
  };
  const apple = patterns.apple.exec.bind(patterns.apple);
  const matchAsciiKey = patterns.asciiKey.exec.bind(patterns.asciiKey);
  const letterCode = patterns.letterCode.exec.bind(patterns.letterCode);
  const digitCode = patterns.digitCode.exec.bind(patterns.digitCode);
  const printableAscii = patterns.printableAscii.exec.bind(patterns.printableAscii);
  const includes = Function.prototype.call.bind(Array.prototype.includes);
  return {
    isApplePlatform(this: void, platform = globalThis.navigator?.platform ?? ""): boolean {
      return apple(platform) !== null;
    },
    resolveAsciiShortcutKey(this: void, event: KeyboardShortcutEvent): string | null {
      if (event.isComposing || event.keyCode === 229) {
        return null;
      }
      const key = strings.lower(event.key);
      if (matchAsciiKey(key) !== null) {
        return key;
      }
      const point = strings.codePointAt(event.key, 0);
      if (
        event.altKey ||
        event.key === "Dead" ||
        event.key.length !== (point !== undefined && point > 0xffff ? 2 : 1)
      ) {
        return null;
      }
      // Preserve character-based Latin shortcuts; non-Latin layouts fall back
      // to the physical key. Count code points without a mutable string iterator.
      const letter = letterCode(event.code)?.[1];
      if (letter) {
        return strings.lower(letter);
      }
      return !event.shiftKey ? (digitCode(event.code)?.[1] ?? null) : null;
    },
    matchesKeyboardShortcut(
      this: void,
      combo: KeyboardShortcutDefinition,
      event: KeyboardShortcutEvent,
      applePlatform: boolean,
      asciiKey: string | null,
    ): boolean {
      if (event.isComposing || event.key === "Dead" || event.keyCode === 229) {
        return false;
      }
      const wantsMod = includes(combo.modifiers, "mod");
      const wantsCtrl = includes(combo.modifiers, "ctrl");
      const primaryModifierMatches = wantsMod
        ? event.metaKey !== event.ctrlKey &&
          (!combo.platformSpecific || event.metaKey === applePlatform)
        : !event.metaKey && event.ctrlKey === wantsCtrl;
      // "/" and Backquote ignore Shift: some layouts need Shift to produce "/",
      // and the shipped terminal chord accepts Ctrl+Shift+` (layouts where the
      // Backquote key is shifted, e.g. producing ~, must keep working).
      const shiftInsensitiveKey = combo.key === "/" || combo.key === "Backquote";
      if (
        !primaryModifierMatches ||
        event.altKey !== includes(combo.modifiers, "alt") ||
        (!shiftInsensitiveKey && event.shiftKey !== includes(combo.modifiers, "shift"))
      ) {
        return false;
      }
      if (combo.key === "/") {
        if (event.key === "/" || event.key === "?") {
          return true;
        }
        // Physical fallback only for non-Latin layouts. Latin layouts that put a
        // different printable on the Slash key (German "-") keep that chord's own
        // meaning — Cmd+"-" must stay browser zoom, not open the overview.
        return event.code === "Slash" && printableAscii(event.key) === null;
      }
      if (combo.key === "Backquote" || combo.key === "Comma") {
        return event.code === combo.key;
      }
      if (
        combo.key === "Enter" ||
        combo.key === "Escape" ||
        combo.key === "ArrowUp" ||
        combo.key === "ArrowDown" ||
        combo.key === "ArrowLeft" ||
        combo.key === "ArrowRight"
      ) {
        return event.key === combo.key;
      }
      // Only Command+Option uses physical letters; Ctrl+Alt may be AltGr text.
      if (asciiKey !== null || !event.metaKey || !event.altKey) {
        return asciiKey === combo.key;
      }
      return event.code === `Key${strings.upper(combo.key)}`;
    },
  };
}

export const { isApplePlatform, resolveAsciiShortcutKey, matchesKeyboardShortcut } =
  createKeyboardShortcutMatcher();
