import { html } from "lit";
import {
  formatKeyboardShortcutCombo,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { handlePeopleMenuKeydown } from "./searchable-people-menu.ts";

// Single-letter context-menu shortcuts. Items opt in via data-shortcut plus a
// rendered hint; menu hosts route non-Escape keydowns here so a bare letter
// clicks the matching enabled item and disabled items swallow nothing.
export function menuShortcutHint(key: string, alias?: KeyboardShortcutCombo) {
  const label = key.length === 1 ? key.toUpperCase() : key;
  return html`<span slot="details" class="session-menu__shortcut" aria-hidden="true"
    >${alias ? `${label} / ${formatKeyboardShortcutCombo(alias)}` : label}</span
  >`;
}

export function activateMenuShortcut(root: ParentNode, event: KeyboardEvent): boolean {
  if (handlePeopleMenuKeydown(event)) {
    return true;
  }
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches("input, textarea, select, [contenteditable=true]"),
      )
  ) {
    return false;
  }
  const key = resolveAsciiShortcutKey(event);
  if (!key) {
    return false;
  }
  const item = root.querySelector<HTMLElement & { disabled?: boolean }>(`[data-shortcut="${key}"]`);
  if (!item || item.disabled || item.getAttribute("aria-disabled") === "true") {
    return false;
  }
  const parentItem = item.closest<HTMLElement & { submenuOpen?: boolean }>(
    'wa-dropdown-item:not([slot="submenu"])',
  );
  if (item.getAttribute("slot") === "submenu" && parentItem?.submenuOpen !== true) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  item.click();
  return true;
}
