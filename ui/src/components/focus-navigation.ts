export function isHtmlElement(value: EventTarget | null): value is HTMLElement {
  // Namespace survives document adoption; realm-specific constructors do not.
  return (
    value !== null &&
    "namespaceURI" in value &&
    value.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
}

const TABBABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, iframe, [contenteditable], [tabindex]";

export function* tabbableElements(elements: Iterable<Element>): Generator<HTMLElement> {
  for (const element of elements) {
    if (element.hasAttribute("inert")) {
      continue;
    }
    if (
      element instanceof HTMLElement &&
      element.matches(TABBABLE_SELECTOR) &&
      !element.matches(":disabled, [data-modal-focus-edge]") &&
      (element.tabIndex >= 0 ||
        (element.isContentEditable &&
          !element.hasAttribute("tabindex") &&
          !element.parentElement?.isContentEditable)) &&
      element.checkVisibility({ visibilityProperty: true })
    ) {
      yield element;
    }
    const assigned =
      element instanceof HTMLSlotElement ? element.assignedElements({ flatten: true }) : [];
    yield* tabbableElements(assigned.length ? assigned : (element.shadowRoot ?? element).children);
  }
}

export function activeElement(host: HTMLElement): HTMLElement | null {
  const view = host.ownerDocument.defaultView;
  const root = host.getRootNode();
  let active =
    (root instanceof ShadowRoot || (view && root instanceof view.ShadowRoot)
      ? root.activeElement
      : null) ?? host.ownerDocument.activeElement;
  while (isHtmlElement(active) && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return isHtmlElement(active) ? active : null;
}
