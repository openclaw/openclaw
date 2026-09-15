import WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import { isServer } from "lit";
// Route-local registration keeps tab internals out of startup.
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";

/** Web Awesome does not forward the host label to its shadow tablist. */
export function tabGroupRef(label: string) {
  let group: WaTabGroup | undefined;
  const revealSelected = () => {
    if (!group?.isConnected) {
      return;
    }
    const active = group.active;
    const selected = Array.from(group.children).find(
      (tab) => tab.localName === "wa-tab" && tab.getAttribute("panel") === active,
    );
    if (selected) {
      // Web Awesome scrolls on selection, but not when its nav or earlier tabs resize.
      // Move only its public navigation scroller, preserving the page's scroll position.
      const tab = selected.getBoundingClientRect();
      const nav = group.nav.getBoundingClientRect();
      group.nav.scrollLeft +=
        tab.left < nav.left ? tab.left - nav.left : Math.max(0, tab.right - nav.right);
    }
  };
  let observer: ResizeObserver | undefined;
  return (element: Element | undefined) => {
    // Lit clears replaced and disconnected refs; queued updates must not revive them.
    observer?.disconnect();
    observer = undefined;
    group = element instanceof WaTabGroup ? element : undefined;
    if (group) {
      const current = group;
      void current.updateComplete.then(() => {
        if (group !== current || !current.isConnected) {
          return;
        }
        current.shadowRoot?.querySelector('[role="tablist"]')?.setAttribute("aria-label", label);
        // Follow Web Awesome's Lit server boundary: server renders have no resize lifecycle.
        if (!isServer) {
          observer = new ResizeObserver(revealSelected);
          observer.observe(current.nav);
          revealSelected();
        }
      });
    }
  };
}
