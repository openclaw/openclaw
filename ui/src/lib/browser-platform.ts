/** Best-effort iPad hint, including its desktop-mode identity; not a capability probe. */
export function isIpadBrowserPlatform(): boolean {
  const nav = globalThis.navigator;
  return /iPad/u.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

/** Best-effort iOS hint, including iPad's desktop-mode identity; not a capability probe. */
export function isIosBrowserPlatform(): boolean {
  return isIpadBrowserPlatform() || /iPhone|iPod/u.test(globalThis.navigator.userAgent);
}

/**
 * Mobile composers keep Return for editing, including tablets with hardware keyboards.
 * Android browsers masking as Linux desktops are indistinguishable from touch PCs;
 * do not use touch or viewport heuristics that would change desktop shortcuts.
 */
export function isMobileBrowserPlatform(): boolean {
  return isIosBrowserPlatform() || /Android/u.test(globalThis.navigator.userAgent);
}

/** Keep native mobile editing, without allowing ancestor shortcuts to submit Return. */
export function keepMobileReturnNative(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || !isMobileBrowserPlatform()) {
    return false;
  }
  event.stopPropagation();
  return true;
}
