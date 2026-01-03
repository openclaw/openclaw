import {
  Editor,
  isAltEnter,
  isCtrlC,
  isCtrlD,
  isCtrlL,
  isCtrlO,
  isCtrlP,
  isCtrlT,
  isEscape,
  isShiftTab,
} from "@mariozechner/pi-tui";

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlL?: () => void;
  onCtrlO?: () => void;
  onCtrlP?: () => void;
  onCtrlT?: () => void;
  onShiftTab?: () => void;
  onAltEnter?: () => void;

  handleInput(data: string): void {
    if (isAltEnter(data) && this.onAltEnter) {
      this.onAltEnter();
      return;
    }
    if (isCtrlL(data) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    if (isCtrlO(data) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (isCtrlP(data) && this.onCtrlP) {
      this.onCtrlP();
      return;
    }
    if (isCtrlT(data) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }
    if (isShiftTab(data) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }
    if (isEscape(data) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (isCtrlC(data) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (isCtrlD(data)) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    super.handleInput(data);
  }
}
