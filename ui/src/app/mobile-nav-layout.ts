import { isSessionRouteId } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import { isNativeEmbedHost, isNativeWebChromeHost } from "./native-web-chrome.ts";

const MOBILE_NAV_MAX_WIDTH = 900;
const NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH = 600;
const FLOATING_HEADER_MEDIA_QUERY =
  "(max-width: 600px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";
const hasNativeShellClass = (...classNames: string[]) =>
  [
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
    ...classNames,
  ].some((className) => document.documentElement.classList.contains(className));

export function mobileNavLayoutMediaQuery(): string {
  if (isNativeWebChromeHost()) {
    return `(max-width: ${NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH}px)`;
  }
  return `(max-width: ${MOBILE_NAV_MAX_WIDTH}px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)`;
}

export function isMobileNavLayout(): boolean {
  return globalThis.matchMedia?.(mobileNavLayoutMediaQuery()).matches ?? false;
}

function usesChatHeader(routeId: RouteId): boolean {
  return (
    isSessionRouteId(routeId) ||
    // The draft wears chat's header on phones, so opening a session moves nothing.
    (routeId === "new-session" &&
      !isNativeEmbedHost() &&
      (globalThis.matchMedia?.(FLOATING_HEADER_MEDIA_QUERY).matches ?? false))
  );
}

export function shouldMergeChatChrome(params: {
  mobileNavLayout: boolean;
  routeId: RouteId;
  onboarding: boolean;
}): boolean {
  return (
    params.mobileNavLayout &&
    usesChatHeader(params.routeId) &&
    !params.onboarding &&
    !hasNativeShellClass()
  );
}

/**
 * Phone pages float their header over the content. Wider drawer layouts and
 * every native host keep the topbar row.
 */
export function shouldFloatShellHeader(params: {
  mobileNavLayout: boolean;
  routeId: RouteId;
  onboarding: boolean;
}): boolean {
  return (
    params.mobileNavLayout &&
    !isSessionRouteId(params.routeId) &&
    // The draft wears chat's header instead.
    params.routeId !== "new-session" &&
    !params.onboarding &&
    !hasNativeShellClass("openclaw-native-desktop") &&
    (globalThis.matchMedia?.(FLOATING_HEADER_MEDIA_QUERY).matches ?? false)
  );
}

export function mergeChatPageChrome(mobileNavLayout: boolean, onboarding: boolean): boolean {
  return shouldMergeChatChrome({ mobileNavLayout, routeId: "chat", onboarding });
}

export function mergeNewSessionPageChrome(onboarding: boolean): boolean {
  return shouldMergeChatChrome({
    mobileNavLayout: isMobileNavLayout(),
    routeId: "new-session",
    onboarding,
  });
}
