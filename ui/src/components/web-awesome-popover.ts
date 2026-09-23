// Route-local registration keeps the popover implementation out of startup.
import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";

const labeledPopovers = new WeakSet<WaPopover>();

/** Web Awesome does not forward the host name to its native shadow dialog. */
export function syncPopoverLabel(element: Element | undefined) {
  if (!(element instanceof WaPopover) || labeledPopovers.has(element)) {
    return;
  }
  labeledPopovers.add(element);

  const sync = () => {
    const dialog = element.dialog;
    if (!element.isConnected || !dialog) {
      return;
    }
    const labelledBy = element.ariaLabelledByElements;
    const label = element.getAttribute("aria-label")?.trim();
    dialog.ariaLabel = label || null;
    // Element references cross the shadow boundary and keep native name
    // computation, including updates to the trigger or referenced heading.
    dialog.ariaLabelledByElements = labelledBy?.length
      ? labelledBy
      : !label && element.anchor
        ? [element.anchor]
        : null;
  };
  const observer = new MutationObserver(sync);
  element.addController({
    hostConnected() {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["aria-label", "aria-labelledby"],
      });
      void element.updateComplete.then(sync);
    },
    hostUpdated: sync,
    hostDisconnected() {
      observer.disconnect();
    },
  });
  sync();
}
