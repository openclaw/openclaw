/** Follow rendered ownership through slots and open shadow roots, never documents. */
export function composedParent(element: Element): Element | null {
  const root = element.getRootNode();
  return (
    element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  );
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

export function anchorFromNavigationEvent(event: Event): HTMLAnchorElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement) {
      return target;
    }
  }
  return event.target instanceof Element ? event.target.closest("a") : null;
}

/** External web links that may be handed to a browser surface. */
export function externalHttpLinkFromEvent(
  event: Event,
): { anchor: HTMLAnchorElement; url: URL } | null {
  const anchor = anchorFromNavigationEvent(event);
  if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("data-file-path")) {
    return null;
  }
  try {
    const url = new URL(anchor.href, window.location.href);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== window.location.origin
      ? { anchor, url }
      : null;
  } catch {
    return null;
  }
}
