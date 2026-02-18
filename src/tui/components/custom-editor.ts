import { Editor, Key, matchesKey } from "@mariozechner/pi-tui";

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
  onPastedImagePath?: (path: string) => boolean; // return true if handled

  handleInput(data: string): void {
    // Intercept bracketed paste containing an image file path before pi-tui processes it.
    // Terminals wrap drag-and-drop file paths in bracketed paste: \x1b[200~<path>\x1b[201~
    if (this.onPastedImagePath && data.includes("\x1b[200~")) {
      const startMarker = "\x1b[200~";
      const endMarker = "\x1b[201~";
      const startIdx = data.indexOf(startMarker);
      const endIdx = data.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1) {
        const pasteContent = data.substring(startIdx + startMarker.length, endIdx);
        const trimmed = pasteContent.trim();
        const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
        const unescaped = unquoted.replace(/\\ /g, " ");
        if (
          unescaped.startsWith("/") &&
          /\.(png|jpe?g|gif|webp|bmp|tiff|svg)$/i.test(unescaped) &&
          !unescaped.includes("\n")
        ) {
          if (this.onPastedImagePath(unescaped)) {
            // Pass through any data after the paste end marker
            const remaining = data.substring(endIdx + endMarker.length);
            if (remaining.length > 0) {
              super.handleInput(remaining);
            }
            return;
          }
        }
      }
    }
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
