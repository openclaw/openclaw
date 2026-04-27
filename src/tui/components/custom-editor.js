import { Editor, Key, matchesKey } from "@mariozechner/pi-tui";
export class CustomEditor extends Editor {
    onEscape;
    onCtrlC;
    onCtrlD;
    onCtrlG;
    onCtrlL;
    onCtrlO;
    onCtrlP;
    onCtrlT;
    onShiftTab;
    onAltEnter;
    onAltUp;
    handleInput(data) {
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
        if (matchesKey(data, Key.ctrl("d"))) {
            if (this.getText().length === 0 && this.onCtrlD) {
                this.onCtrlD();
            }
            return;
        }
        super.handleInput(data);
    }
}
