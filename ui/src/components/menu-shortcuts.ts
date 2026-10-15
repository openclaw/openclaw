import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";

// Single-letter context-menu shortcuts. Items opt in via data-shortcut plus a
// rendered hint; menu hosts route non-Escape keydowns here so a bare letter
// clicks the matching enabled item and disabled items swallow nothing.
export function activateMenuShortcut(root: ParentNode, event: KeyboardEvent): boolean {
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
  const item = Array.from(root.querySelectorAll<HTMLElement>(`[data-shortcut="${key}"]`)).find(
    (candidate) =>
      !candidate.matches(":disabled") &&
      candidate.getAttribute("aria-disabled") !== "true" &&
      candidate.closest('[role="menu"]')?.matches(":popover-open"),
  );
  if (!item) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  item.click();
  return true;
}
