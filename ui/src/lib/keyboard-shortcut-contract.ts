import {
  COMMAND_PALETTE_SHORTCUT,
  COMMAND_PALETTE_SHORTCUTS,
  isApplePlatform,
  matchesKeyboardShortcut,
  resolveAsciiShortcutKey,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutModifier,
} from "../../../src/shared/keyboard-shortcuts.ts";
import { isNativeWebChromeHost } from "../app/native-web-chrome.ts";
import type { KEYBOARD_REFERENCE_COMBOS } from "./keyboard-shortcut-reference.ts";

export { isApplePlatform } from "../../../src/shared/keyboard-shortcuts.ts";

export const KEYBOARD_SHORTCUT_COMBOS = {
  commandPalette: COMMAND_PALETTE_SHORTCUT,
  newSession: { modifiers: ["mod", "shift"], key: "o", platformSpecific: true },
  nativeNewSession: { modifiers: ["mod"], key: "n", platformSpecific: true },
  archiveSession: { modifiers: ["mod", "shift"], key: "a", platformSpecific: true },
  previousSession: { modifiers: ["mod"], key: "[", platformSpecific: true },
  nextSession: { modifiers: ["mod"], key: "]", platformSpecific: true },
  keyboardShortcuts: { modifiers: ["mod"], key: "/" },
  toggleSidebar: { modifiers: ["mod"], key: "b", platformSpecific: true },
  debugOverlay: { modifiers: ["mod", "shift"], key: "d" },
  appearanceSettings: { modifiers: ["mod", "shift"], key: "Comma" },
  escape: { modifiers: [], key: "Escape" },
  sendMessage: { modifiers: [], key: "Enter" },
  modifiedEnter: { modifiers: ["mod"], key: "Enter" },
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
} as const satisfies Record<string, KeyboardShortcutDefinition>;

type KeyboardShortcutKey =
  | (typeof KEYBOARD_REFERENCE_COMBOS)[keyof typeof KEYBOARD_REFERENCE_COMBOS]["key"]
  | (typeof KEYBOARD_SHORTCUT_COMBOS)[keyof typeof KEYBOARD_SHORTCUT_COMBOS]["key"]
  | (typeof COMMAND_PALETTE_SHORTCUTS)[number]["key"];
export type KeyboardShortcutCombo = KeyboardShortcutDefinition<KeyboardShortcutKey>;

export function resolveNewSessionShortcut(): KeyboardShortcutCombo {
  // Browser tabs retain New Window; desktop hosts own their window shortcuts.
  return isNativeWebChromeHost()
    ? KEYBOARD_SHORTCUT_COMBOS.nativeNewSession
    : KEYBOARD_SHORTCUT_COMBOS.newSession;
}

export function formatKeyboardShortcutParts(
  combo: KeyboardShortcutCombo,
  applePlatform = isApplePlatform(),
): string[] {
  const modifiers: Record<KeyboardShortcutModifier, string> = applePlatform
    ? { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" }
    : { mod: "Ctrl", ctrl: "Ctrl", shift: "⇧", alt: "Alt" };
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

export function matchesShortcutCombo(combo: KeyboardShortcutCombo, event: KeyboardEvent): boolean {
  // Bracket navigation follows the produced character, not US physical-key positions.
  const key = combo.key === "[" || combo.key === "]" ? event.key : resolveAsciiShortcutKey(event);
  return matchesKeyboardShortcut(combo, event, isApplePlatform(), key);
}

/** Runtime controls of the lazily loaded shortcuts dialog. */
export type KeyboardShortcutsDialogElement = HTMLElement & {
  isOpen: boolean;
  toggle: () => void;
};
