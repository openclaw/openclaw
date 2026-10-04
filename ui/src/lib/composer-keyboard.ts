import { isIosBrowserPlatform } from "./browser-platform.ts";

/** Keep mobile Return native; explicit hardware-keyboard submit chords remain available. */
export function isNativeMobileReturn(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    !event.ctrlKey &&
    !event.metaKey &&
    (isIosBrowserPlatform() || /Android/u.test(navigator.userAgent))
  );
}
