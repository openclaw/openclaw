/** Best-effort iOS hint, including iPad's desktop-mode identity; not a capability probe. */
export function isIosBrowserPlatform(): boolean {
  const nav = globalThis.navigator;
  return (
    /iPad|iPhone|iPod/u.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

/**
 * Mobile software keyboards keep Return for editing.
 * Android browsers masking as Linux desktops are indistinguishable from touch PCs;
 * do not use touch or viewport heuristics that would change desktop shortcuts.
 */
export function isMobileBrowserPlatform(): boolean {
  return isIosBrowserPlatform() || /Android/u.test(globalThis.navigator.userAgent);
}

/** Keep software Return native, without letting ancestor shortcuts submit it. */
export function keepMobileReturnNative(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || !isMobileBrowserPlatform()) {
    return false;
  }
  // iOS supplies a physical key code for hardware Return. Decide per event so
  // using a Magic Keyboard never turns a later on-screen Return into Send.
  // Missing/unknown codes stay native; Android software keyboards may supply codes.
  if (isIosBrowserPlatform() && (event.code === "Enter" || event.code === "NumpadEnter")) {
    return false;
  }
  event.stopPropagation();
  return true;
}
