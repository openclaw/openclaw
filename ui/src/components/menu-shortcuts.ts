import { registryFor } from "./overlay-registry.ts";

const shortcutItems = new WeakMap<
  HTMLElement,
  {
    items: () => Iterable<{ element: HTMLElement; key: string | undefined }>;
    search?: () => HTMLInputElement | undefined;
  }
>();

/** Renderers publish the same enabled shortcut elements that receive activation. */
export function registerMenuShortcuts(
  surface: HTMLElement,
  read: () => Iterable<{ element: HTMLElement; key: string | undefined }>,
  search?: () => HTMLInputElement | undefined,
): () => void {
  shortcutItems.set(surface, { items: read, search });
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
  for (const { element, key: advertisedKey } of shortcutItems.get(surface)?.items() ?? []) {
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

/** Hover can open a submenu while keyboard focus remains in its parent. */
export function findMenuSearch(surface: HTMLElement): HTMLInputElement | undefined {
  const active = registryFor(surface.ownerDocument).stack.findLast(
    (overlay) => overlay.open && surface.contains(overlay.surface),
  );
  const search = active && shortcutItems.get(active.surface)?.search?.();
  return search &&
    !search.disabled &&
    !search.readOnly &&
    !search.closest("[inert]") &&
    search.checkVisibility({ checkVisibilityCSS: true })
    ? search
    : undefined;
}

export function menuOwnsShortcut(surface: HTMLElement, key: string): boolean {
  return /^[a-z0-9]$/iu.test(key) && Boolean(findMenuShortcut(surface, key.toLowerCase()));
}
