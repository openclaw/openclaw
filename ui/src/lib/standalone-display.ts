/**
 * Home screen web apps (iOS "Add to Home Screen") have no browser chrome, so a
 * file navigation replaces the app with no way back and no way to save it.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // iOS Safari reports home screen apps through the non-standard navigator.standalone.
  if (Reflect.get(navigator, "standalone") === true) {
    return true;
  }
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(display-mode: standalone)").matches
    : false;
}
