const sessionSplitHosts = new Map<HTMLElement, () => boolean>();

/** Chat publishes its mounted capability without exposing its DOM to menu callers. */
export function registerSessionSplitHost(host: HTMLElement, available: () => boolean) {
  sessionSplitHosts.set(host, available);
  return () => {
    sessionSplitHosts.delete(host);
  };
}

export function canSplitSessionView(): boolean {
  return [...sessionSplitHosts].some(([host, available]) => host.isConnected && available());
}
