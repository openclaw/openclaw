import { isSessionRouteId } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

const MOBILE_NAV_MAX_WIDTH = 900;
const NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH = 600;
const NATIVE_SHELL_CLASSES = [
  "openclaw-native-macos",
  "openclaw-native-nav",
  "openclaw-native-web-chrome",
] as const;

export function mobileNavLayoutMediaQuery(): string {
  if (isNativeWebChromeHost()) {
    return `(max-width: ${NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH}px)`;
  }
  return `(max-width: ${MOBILE_NAV_MAX_WIDTH}px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)`;
}

export function isMobileNavLayout(): boolean {
  return globalThis.matchMedia?.(mobileNavLayoutMediaQuery()).matches ?? false;
}

function hasNativeShellClass(): boolean {
  return NATIVE_SHELL_CLASSES.some((className) =>
    document.documentElement.classList.contains(className),
  );
}

export function shouldMergeChatChrome(params: {
  mobileNavLayout: boolean;
  routeId: RouteId;
  onboarding: boolean;
}): boolean {
  return (
    params.mobileNavLayout &&
    isSessionRouteId(params.routeId) &&
    !params.onboarding &&
    !hasNativeShellClass()
  );
}

export function mergeChatPageChrome(mobileNavLayout: boolean, onboarding: boolean): boolean {
  return shouldMergeChatChrome({ mobileNavLayout, routeId: "chat", onboarding });
}
