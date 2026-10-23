import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";

export function sessionArchiveShortcut(state: {
  session: { archived: boolean };
  selectionCount: number;
  archiveShortcut?: boolean;
}): KeyboardShortcutCombo | undefined {
  return state.archiveShortcut && state.selectionCount === 1 && !state.session.archived
    ? KEYBOARD_SHORTCUT_COMBOS.archiveSession
    : undefined;
}
