import type { KeyboardShortcutDefinition } from "../../../src/shared/keyboard-shortcuts.ts";

// Reference-only chords and image-viewer controls are not needed at shell startup.
export const KEYBOARD_REFERENCE_COMBOS = {
  newline: { modifiers: ["shift"], key: "Enter" },
  historyPrevious: { modifiers: [], key: "ArrowUp" },
  historyNext: { modifiers: [], key: "ArrowDown" },
  zoomIn: { modifiers: [], key: "+" },
  zoomOut: { modifiers: [], key: "-" },
  zoomReset: { modifiers: [], key: "0" },
  imagePanLeft: { modifiers: ["shift"], key: "ArrowLeft" },
  imagePanRight: { modifiers: ["shift"], key: "ArrowRight" },
  imagePanUp: { modifiers: ["shift"], key: "ArrowUp" },
  imagePanDown: { modifiers: ["shift"], key: "ArrowDown" },
  // Display-only mouse chords; never keyboard-matched.
  toggleSessionSelect: { modifiers: ["alt"], key: "Click" },
  extendSessionSelect: { modifiers: ["shift"], key: "Click" },
} as const satisfies Record<string, KeyboardShortcutDefinition>;
