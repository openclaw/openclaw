/** Follow rendered ownership through slots and open shadow roots, never documents. */
export function composedParent(element: Element): Element | null {
  const root = element.getRootNode();
  return (
    element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  );
}

/** Include slot, shadow-root and document nodes for presentation observation. */
export function composedAncestors(start: Node | null): Node[] {
  const ancestors: Node[] = [];
  for (let node = start; node;) {
    ancestors.push(node);
    node =
      node instanceof Element && node.assignedSlot
        ? node.assignedSlot
        : node instanceof ShadowRoot
          ? node.host
          : node.parentNode;
  }
  return ancestors;
}

/** Ordinary primary click without modifiers; anything else keeps native link behavior. */
export function shouldHandleNavigationClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Delegated clicks may originate in caller-owned light DOM or shadow-root islands. */
export function anchorFromNavigationEvent(event: Event): HTMLAnchorElement | null {
  return (
    event.composedPath().find((target) => target instanceof HTMLAnchorElement) ??
    (event.target instanceof Element ? event.target.closest("a") : null)
  );
}

/** External web links that may be handed to a browser surface. */
export function externalHttpLinkFromEvent(
  event: Event,
): { anchor: HTMLAnchorElement; url: URL } | null {
  const anchor = anchorFromNavigationEvent(event);
  if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("data-file-path")) {
    return null;
  }
  const url = URL.parse(anchor.href, window.location.href);
  return url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== window.location.origin
    ? { anchor, url }
    : null;
}
