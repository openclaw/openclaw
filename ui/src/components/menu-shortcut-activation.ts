import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { findMenuShortcut } from "./menu-shortcuts.ts";

// Keep activation with menu renderers; printable-key admission also runs on New Session.
export function activateMenuShortcut(
  surface: HTMLElement | undefined,
  event: KeyboardEvent,
): boolean {
  const path = event.composedPath();
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    path.some(
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
  for (const target of [surface, ...path]) {
    const item = target instanceof HTMLElement && findMenuShortcut(target, key);
    if (item) {
      event.preventDefault();
      event.stopPropagation();
      item.click();
      return true;
    }
  }
  return false;
}
