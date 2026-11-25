// Keyboard navigation replaces route-owned strips. The destination restores focus
// only while the user has not moved it elsewhere.
const PENDING_FOCUS_WINDOW_MS = 2000;
let pendingFocus: { hubId: string; tab: string; at: number; source: Element } | null = null;

export function rememberHubTabFocus(hubId: string, tab: string, source: Element) {
  pendingFocus = { hubId, tab, at: Date.now(), source };
}

export function reclaimHubTabFocus(hubId: string, tab: string, element: Element | undefined) {
  if (
    !(element instanceof HTMLElement) ||
    pendingFocus?.hubId !== hubId ||
    pendingFocus.tab !== tab
  ) {
    return;
  }
  const pending = pendingFocus;
  if (Date.now() - pending.at > PENDING_FOCUS_WINDOW_MS) {
    pendingFocus = null;
    return;
  }
  // Wait for the destination DOM commit without overriding newer user focus.
  queueMicrotask(() => {
    if (pendingFocus !== pending) {
      return;
    }
    pendingFocus = null;
    const currentFocus = element.ownerDocument.activeElement;
    if (
      element.isConnected &&
      Date.now() - pending.at <= PENDING_FOCUS_WINDOW_MS &&
      (currentFocus === pending.source ||
        currentFocus === element.ownerDocument.body ||
        currentFocus === element.ownerDocument.documentElement)
    ) {
      element.focus();
    }
  });
}
