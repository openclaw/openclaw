import {
  Editor,
  type EditorOptions,
  type EditorTheme,
  Key,
  matchesKey,
} from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";

type ViMode = "insert" | "normal";

export interface CustomEditorOptions extends EditorOptions {
  viMode?: boolean;
}

export class CustomEditor extends Editor {
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

  private readonly viEnabled: boolean;
  private viMode: ViMode = "insert";
  // Tracks whether the first 'd' of a 'dd' sequence was pressed.
  private pendingD = false;

  constructor(tui: TUI, theme: EditorTheme, options?: CustomEditorOptions) {
    super(tui, theme, options);
    this.viEnabled = options?.viMode ?? false;
  }

  /** Returns the current vi mode if vi is enabled, null otherwise. */
  getViMode(): ViMode | null {
    return this.viEnabled ? this.viMode : null;
  }

  handleInput(data: string): void {
    if (this.viEnabled) {
      if (this.viMode === "insert") {
        // Escape in insert mode switches to normal mode — do NOT call onEscape.
        if (matchesKey(data, Key.escape) && !this.isShowingAutocomplete()) {
          this.viMode = "normal";
          this.pendingD = false;
          this.invalidate();
          return;
        }
        // All other input falls through to the existing handler below.
      } else {
        // Normal mode: handle vi bindings first.
        if (this.handleViNormalInput(data)) {
          return;
        }
        // Unrecognised in normal mode: fall through for control sequences.
      }
    }

    this.handleExistingInput(data);
  }

  /**
   * Handle a keypress in vi normal mode.
   * Returns true if the input was consumed, false if it should fall through.
   */
  private handleViNormalInput(data: string): boolean {
    // Escape in normal mode → abort (same as non-vi behaviour).
    if (matchesKey(data, Key.escape)) {
      if (this.onEscape && !this.isShowingAutocomplete()) {
        this.pendingD = false;
        this.onEscape();
      }
      return true;
    }

    // Enter → submit (delegate to existing handler).
    if (matchesKey(data, Key.enter)) {
      this.pendingD = false;
      this.handleExistingInput(data);
      return true;
    }

    // ── Mode transitions ────────────────────────────────────────────────────

    if (data === "i") {
      this.pendingD = false;
      this.viMode = "insert";
      this.invalidate();
      return true;
    }
    if (data === "a") {
      this.pendingD = false;
      this.viMode = "insert";
      super.handleInput("\x1b[C"); // move cursor one right (after current char)
      this.invalidate();
      return true;
    }
    if (data === "A") {
      this.pendingD = false;
      this.viMode = "insert";
      super.handleInput("\x1b[F"); // end of line
      this.invalidate();
      return true;
    }
    if (data === "I") {
      this.pendingD = false;
      this.viMode = "insert";
      super.handleInput("\x1b[H"); // start of line
      this.invalidate();
      return true;
    }

    // ── Cursor movement ──────────────────────────────────────────────────────

    if (data === "h") {
      this.pendingD = false;
      super.handleInput("\x1b[D"); // left arrow
      return true;
    }
    if (data === "l") {
      this.pendingD = false;
      super.handleInput("\x1b[C"); // right arrow
      return true;
    }
    if (data === "j") {
      this.pendingD = false;
      super.handleInput("\x1b[B"); // down arrow
      return true;
    }
    if (data === "k") {
      this.pendingD = false;
      super.handleInput("\x1b[A"); // up arrow
      return true;
    }
    if (data === "w") {
      this.pendingD = false;
      super.handleInput("\x1bOc"); // ctrl+right — word forward
      return true;
    }
    if (data === "b") {
      this.pendingD = false;
      super.handleInput("\x1bOd"); // ctrl+left — word backward
      return true;
    }
    if (data === "0") {
      this.pendingD = false;
      super.handleInput("\x1b[H"); // home — start of line
      return true;
    }
    if (data === "$") {
      this.pendingD = false;
      super.handleInput("\x1b[F"); // end — end of line
      return true;
    }

    // ── Editing ──────────────────────────────────────────────────────────────

    // x — delete character under cursor (forward delete).
    if (data === "x") {
      this.pendingD = false;
      super.handleInput("\x1b[3~"); // Delete key
      return true;
    }

    // dd — delete current line (or clear entire input when single-line).
    if (data === "d") {
      if (this.pendingD) {
        this.pendingD = false;
        const lines = this.getLines();
        if (lines.length <= 1) {
          this.setText("");
        } else {
          const cursor = this.getCursor();
          const newLines = lines.filter((_, i) => i !== cursor.line);
          this.setText(newLines.join("\n"));
        }
        return true;
      }
      this.pendingD = true;
      return true;
    }

    // u — undo (ctrl+- in the editor keybinding).
    if (data === "u") {
      this.pendingD = false;
      super.handleInput("\x1f"); // ctrl+- maps to 0x1F
      return true;
    }

    // Any other printable character: consume without typing.
    if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
      this.pendingD = false;
      return true;
    }

    // Control sequences / special keys: do not consume — fall through.
    this.pendingD = false;
    return false;
  }

  /** Re-implementation of the pre-vi handleInput logic. */
  private handleExistingInput(data: string): void {
    if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
      this.onAltEnter();
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
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    super.handleInput(data);
  }
}
