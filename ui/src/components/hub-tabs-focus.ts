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
  // Refs can run before connecting; let the renderer and Web Awesome settle first.
  window.setTimeout(() => {
    if (pendingFocus !== pending) {
      return;
    }
    pendingFocus = null;
    const currentFocus = document.activeElement;
    if (
      element.isConnected &&
      Date.now() - pending.at <= PENDING_FOCUS_WINDOW_MS &&
      (currentFocus === pending.source ||
        currentFocus === document.body ||
        currentFocus === document.documentElement)
    ) {
      element.focus();
    }
  }, 0);
}
