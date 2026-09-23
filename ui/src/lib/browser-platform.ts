/** Best-effort iOS hint, including iPad's desktop-mode identity; not a capability probe. */
export function isIosBrowserPlatform(): boolean {
  const nav = globalThis.navigator;
  return (
    /iPad|iPhone|iPod/u.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}
