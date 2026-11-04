import { occludeNativeBrowserSurface } from "../lib/native-overlay-occlusion.ts";

const connectedSurfaces = new Set<HTMLElement>();

/** A mounted menu host owns Escape even when its native popover is closed. */
export function hasMenuSurface(document: Document): boolean {
  for (const surface of connectedSurfaces) {
    if (surface.ownerDocument === document) {
      return true;
    }
  }
  return false;
}

/**
 * Promotes a connected element into the browser popover top layer so transient
 * menus paint above every in-page stacking context (e.g. the sidebar resizer
 * divider that sits above the nav's z-index 10 context).
 */
export function promoteToPopoverTopLayer(element: HTMLElement, surfaces: () => Iterable<Element>) {
  occludeNativeBrowserSurface(element, surfaces);
  element.setAttribute("popover", "manual");
  element.showPopover();
}

/**
 * Light-DOM host that lifts template-rendered menus into the popover top
 * layer on connect. Hosts render fixed-position menu markup as children;
 * closing removes the element, which auto-hides the popover.
 */
class MenuSurface extends HTMLElement {
  connectedCallback() {
    connectedSurfaces.add(this);
    promoteToPopoverTopLayer(this, () => this.children);
  }

  disconnectedCallback() {
    connectedSurfaces.delete(this);
  }
}

if (!customElements.get("openclaw-menu-surface")) {
  customElements.define("openclaw-menu-surface", MenuSurface);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-menu-surface": MenuSurface;
  }
}
