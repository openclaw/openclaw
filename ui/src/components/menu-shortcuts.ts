import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { registryFor } from "./overlay-registry.ts";

const shortcutItems = new WeakMap<
  HTMLElement,
  () => Iterable<{ element: HTMLElement; key: string | undefined }>
>();

/** Renderers publish the same enabled shortcut elements that receive activation. */
export function registerMenuShortcuts(
  surface: HTMLElement,
  read: () => Iterable<{ element: HTMLElement; key: string | undefined }>,
): () => void {
  shortcutItems.set(surface, read);
  return () => shortcutItems.delete(surface);
}

function shortcutInSurface(surface: HTMLElement, key: string): HTMLElement | undefined {
  if (
    !(surface instanceof HTMLDetailsElement ? surface.open : surface.matches(":popover-open")) ||
    surface.closest("[inert]")
  ) {
    return undefined;
  }
  for (const { element, key: advertisedKey } of shortcutItems.get(surface)?.() ?? []) {
    if (
      advertisedKey === key &&
      !element.matches(":disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    ) {
      return element;
    }
  }
  return undefined;
}

function findMenuShortcut(root: Node, key: string): HTMLElement | undefined {
  if (root instanceof HTMLElement) {
    const own = shortcutInSurface(root, key);
    if (own) {
      return own;
    }
  }
  for (const overlay of registryFor(root.ownerDocument ?? document).members.keys()) {
    if (root.contains(overlay.surface)) {
      const item = shortcutInSurface(overlay.surface, key);
      if (item) {
        return item;
      }
    }
  }
  return undefined;
}

export function menuOwnsShortcut(root: Node, key: string): boolean {
  return /^[a-z0-9]$/iu.test(key) && Boolean(findMenuShortcut(root, key.toLowerCase()));
}

// Single-letter context-menu shortcuts. Items opt in via data-shortcut plus a
// rendered hint; menu hosts route non-Escape keydowns here so a bare letter
// clicks the matching enabled item and disabled items swallow nothing.
export function activateMenuShortcut(root: Node, event: KeyboardEvent): boolean {
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
  const item = findMenuShortcut(root, key);
  if (!item) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  item.click();
  return true;
}
