import { Editor } from "@mariozechner/pi-tui";
export declare class CustomEditor extends Editor {
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
    handleInput(data: string): void;
}
