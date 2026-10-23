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

export function findMenuShortcut(
  surface: HTMLElement | undefined,
  key: string,
): HTMLElement | undefined {
  if (
    !surface ||
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

export function menuOwnsShortcut(surface: HTMLElement, key: string): boolean {
  return /^[a-z0-9]$/iu.test(key) && Boolean(findMenuShortcut(surface, key.toLowerCase()));
}
