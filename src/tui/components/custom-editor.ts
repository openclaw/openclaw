// Custom editor component handles multiline TUI input and key bindings.
import { Editor, getKeybindings, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

// Kitty keyboard protocol uses CSI-u sequences for AltGr on international layouts.
const KITTY_CSI_U_SUFFIX_REGEX = /^(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/u;
const KITTY_MODIFIERS = {
  alt: 2,
  ctrl: 4,
};
const LOCK_MODIFIER_MASK = 64 + 128;
const LEGACY_ALT_RECOVERY_WINDOW_MS = 100;

// Decodes Ctrl+Alt layout output into the intended printable AltGr character.
function decodeAltGrPrintable(data: string): string | undefined {
  if (!data.startsWith("\u001b[")) {
    return undefined;
  }

  const match = data.slice(2).match(KITTY_CSI_U_SUFFIX_REGEX);
  if (!match) {
    return undefined;
  }

  const codepoint = Number.parseInt(match[1] ?? "", 10);
  const baseLayoutKey = match[3] ? Number.parseInt(match[3], 10) : undefined;
  const modifierValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = (Number.isFinite(modifierValue) ? modifierValue - 1 : 0) & ~LOCK_MODIFIER_MASK;

  if (modifier !== (KITTY_MODIFIERS.alt | KITTY_MODIFIERS.ctrl)) {
    return undefined;
  }
  if (typeof baseLayoutKey !== "number" || baseLayoutKey === codepoint) {
    return undefined;
  }
  if (!Number.isFinite(codepoint) || codepoint < 32) {
    return undefined;
  }

  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

// Decodes a legacy Alt chord (ESC + printable byte) back into its printable character.
function decodeLegacyAltPrintable(data: string): string | undefined {
  if (data.length !== 2 || !data.startsWith("\u001b")) {
    return undefined;
  }
  const codepoint = data.charCodeAt(1);
  if (codepoint < 32 || codepoint === 127) {
    return undefined;
  }
  return data[1];
}

/** Editor with OpenClaw TUI shortcuts layered on top of pi-tui text editing. */
export class CustomEditor extends Editor {
  private recoverLegacyAltPrintableUntil = 0;
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlG?: () => void;
  onCtrlL?: () => void;
  onCtrlO?: () => void;
  onCtrlP?: () => void;
  onCtrlT?: () => void;
  onShiftTab?: () => void;
  onAltEnter?: () => void;
  onAltUp?: () => void;
  shouldSubmitAutocomplete?: (text: string) => boolean;

  recoverNextLegacyAltPrintable(): void {
    this.recoverLegacyAltPrintableUntil = Date.now() + LEGACY_ALT_RECOVERY_WINDOW_MS;
  }

  /** Preserve raw submit text so the owner chooses local editor dispatch before trimming. */
  override handleInput(data: string): void {
    if (isKeyRelease(data)) {
      return;
    }

    if (this.recoverLegacyAltPrintableUntil > 0) {
      const armed = Date.now() <= this.recoverLegacyAltPrintableUntil;
      this.recoverLegacyAltPrintableUntil = 0;
      const printable = armed ? decodeLegacyAltPrintable(data) : undefined;
      if (printable !== undefined) {
        super.handleInput(printable);
        return;
      }
    }

    if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
      this.onAltEnter();
      return;
    }
    if (matchesKey(data, Key.alt("up")) && this.onAltUp) {
      this.onAltUp();
      return;
    }
    if (matchesKey(data, Key.ctrl("l")) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP) {
      this.onCtrlP();
      return;
    }
    if (matchesKey(data, Key.ctrl("g")) && this.onCtrlG) {
      this.onCtrlG();
      return;
    }
    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl("d")) && this.getText().length === 0 && this.onCtrlD) {
      this.onCtrlD();
      return;
    }

    const altGrPrintable = decodeAltGrPrintable(data);
    if (altGrPrintable !== undefined) {
      super.handleInput(altGrPrintable);
      return;
    }

    const keybindings = getKeybindings();
    if (
      this.isShowingAutocomplete() &&
      keybindings.matches(data, "tui.select.confirm") &&
      keybindings.matches(data, "tui.input.submit")
    ) {
      const cursor = this.getCursor();
      const lines = this.getLines();
      const cursorAtEnd =
        cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line]?.length ?? 0);
      if (cursorAtEnd && this.shouldSubmitAutocomplete?.(this.getText())) {
        // Exact argument already present: close the picker so this Enter reaches submit.
        this.setText(this.getText());
      }
    }

    if (keybindings.matches(data, "tui.input.submit") && this.onSubmit) {
      const expandedText = this.getExpandedText();
      const onSubmit = this.onSubmit;
      // pi-tui may complete a command before submitting. Keep that completed text
      // inside the original whitespace boundary so trimming cannot change its action.
      this.onSubmit = (text) => onSubmit(expandedText.replace(expandedText.trim(), () => text));
      try {
        super.handleInput(data);
      } finally {
        this.onSubmit = onSubmit;
      }
      return;
    }
    super.handleInput(data);
  }
}
