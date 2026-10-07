import {
  COMMAND_PALETTE_SHORTCUT,
  isApplePlatform,
  matchesKeyboardShortcut,
  resolveAsciiShortcutKey,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutModifier,
} from "../../../src/shared/keyboard-shortcuts.ts";

export { isApplePlatform } from "../../../src/shared/keyboard-shortcuts.ts";

export const KEYBOARD_SHORTCUT_COMBOS = {
  commandPalette: COMMAND_PALETTE_SHORTCUT,
  newSession: { modifiers: ["mod", "shift"], key: "o", platformSpecific: true },
  archiveSession: { modifiers: ["mod", "shift"], key: "a", platformSpecific: true },
  keyboardShortcuts: { modifiers: ["mod"], key: "/" },
  toggleSidebar: { modifiers: ["mod"], key: "b", platformSpecific: true },
  debugOverlay: { modifiers: ["mod", "shift"], key: "d" },
  appearanceSettings: { modifiers: ["mod", "shift"], key: "Comma" },
  escape: { modifiers: [], key: "Escape" },
  sendMessage: { modifiers: [], key: "Enter" },
  modifiedEnter: { modifiers: ["mod"], key: "Enter" },
  newline: { modifiers: ["shift"], key: "Enter" },
  transcriptSearch: { modifiers: ["mod"], key: "f", platformSpecific: true },
  terminalPanel: { modifiers: ["ctrl"], key: "Backquote" },
  homePanel: { modifiers: ["mod", "shift"], key: "h" },
  workspaceFiles: { modifiers: ["mod", "shift"], key: "b" },
  sideChat: { modifiers: ["mod", "shift"], key: "s" },
  browserPanel: { modifiers: ["mod", "alt", "shift"], key: "u" },
  desktopPanel: { modifiers: ["mod", "alt", "shift"], key: "d" },
  discussionPanel: { modifiers: ["mod", "alt", "shift"], key: "j" },
  dashboardPanel: { modifiers: ["mod", "alt", "shift"], key: "g" },
  reviewPanel: { modifiers: ["mod", "alt", "shift"], key: "e" },
  approveAlways: { modifiers: ["mod", "shift"], key: "Enter" },
  denyApproval: { modifiers: ["mod"], key: "d" },
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

type KeyboardShortcutKey =
  (typeof KEYBOARD_SHORTCUT_COMBOS)[keyof typeof KEYBOARD_SHORTCUT_COMBOS]["key"];
export type KeyboardShortcutCombo = KeyboardShortcutDefinition<KeyboardShortcutKey>;

export function formatKeyboardShortcutParts(
  combo: KeyboardShortcutCombo,
  applePlatform = isApplePlatform(),
): string[] {
  const modifiers: Record<KeyboardShortcutModifier, string> = applePlatform
    ? { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" }
    : { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
  const keys: Partial<Record<KeyboardShortcutKey, string>> = {
    Backquote: "`",
    Comma: ",",
    Enter: applePlatform ? "⏎" : "Enter",
    Escape: applePlatform ? "esc" : "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Click: "Click",
  };
  return [
    ...combo.modifiers.map((modifier) => modifiers[modifier]),
    keys[combo.key] ?? combo.key.toUpperCase(),
  ];
}

export function formatKeyboardShortcutCombo(
  combo: KeyboardShortcutCombo,
  applePlatform = isApplePlatform(),
): string {
  return formatKeyboardShortcutParts(combo, applePlatform).join(applePlatform ? "" : "+");
}

export function matchesShortcutCombo(combo: KeyboardShortcutCombo, event: KeyboardEvent): boolean {
  return matchesKeyboardShortcut(combo, event, isApplePlatform(), resolveAsciiShortcutKey(event));
}

/** Runtime controls of the lazily loaded shortcuts dialog. */
export type KeyboardShortcutsDialogElement = HTMLElement & {
  isOpen: boolean;
  toggle: () => void;
};
