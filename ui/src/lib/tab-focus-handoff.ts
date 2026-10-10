const HANDOFF_WINDOW_MS = 2000;
let pending: { group: string; value: string; source: HTMLElement; at: number } | undefined;

export function rememberTabFocus(group: string, value: string, source: HTMLElement) {
  pending = { group, value, source, at: Date.now() };
}

export function reclaimTabFocus(group: string, value: string, target: Element | undefined) {
  if (!(target instanceof HTMLElement) || pending?.group !== group || pending.value !== value) {
    return;
  }
  const request = pending;
  // Route renderers can replace the source strip. Only reclaim abandoned focus;
  // deliberate focus placed elsewhere while the route loads always wins.
  queueMicrotask(() => {
    if (pending !== request) {
      return;
    }
    pending = undefined;
    const current = target.ownerDocument.activeElement;
    if (
      target.isConnected &&
      Date.now() - request.at <= HANDOFF_WINDOW_MS &&
      (current === request.source ||
        current === target.ownerDocument.body ||
        current === target.ownerDocument.documentElement)
    ) {
      target.focus();
    }
  });
}
