import { focusProgrammatically } from "../../lib/programmatic-focus.ts";
import type { Overlay } from "../overlay-lifecycle.ts";
import { containsComposed } from "../overlay-registry.ts";

// Embedded menu triggers opt in explicitly; submenu items keep their native roving focus.
export const MENU_FORM_CONTROL_SELECTOR =
  ':is(input, textarea, select, [data-form-control], button, a[href]):not([role^="menuitem"]):not([aria-haspopup="menu"]:not([data-form-control]))';

/** A nested open surface handles its own input, including across a shadow root. */
export function ownsMenuTarget(
  overlay: Overlay,
  target: HTMLElement,
  surface: "menu" | "listbox" = "menu",
): boolean {
  return (
    (surface === "listbox"
      ? overlay.surface.contains(target)
      : target.closest('[role="menu"]') === overlay.surface) &&
    ![...overlay.children].some((child) => child.open && containsComposed(child.surface, target))
  );
}

export function compareMenuElements(left: HTMLElement, right: HTMLElement): number {
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

export function focusMenuRow(row: HTMLElement) {
  focusProgrammatically(row, { preventScroll: true });
  row.scrollIntoView({ block: "nearest", inline: "nearest" });
}
