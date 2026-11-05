import { isNativeWebChromeHost, nativeEmbedHost } from "./native-web-chrome.ts";

export const HOST_CONTENT_ZOOM_MEDIA_QUERY = "(any-hover: hover) and (any-pointer: fine)";

type NativeContentZoomWindow = Window & {
  chrome?: { webview?: unknown };
  __OPENCLAW_NATIVE_CONTENT_ZOOM__?: {
    supported: true;
    adoptLegacyTextScale?: (percentage: number) => Promise<void>;
  };
};

export function nativeContentZoomHost() {
  if (typeof window === "undefined") {
    return null;
  }
  // SAFETY: native hosts install this document-start adapter; validate its callable boundary.
  const host = (window as NativeContentZoomWindow)["__OPENCLAW_NATIVE_CONTENT_ZOOM__"];
  return host?.supported === true &&
    (host.adoptLegacyTextScale === undefined || typeof host.adoptLegacyTextScale === "function")
    ? host
    : null;
}

export function usesHostContentZoom(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const embed = nativeEmbedHost();
  if (embed && embed.formFactor !== "desktop") {
    return false;
  }
  if (nativeContentZoomHost()) {
    return true;
  }
  // A desktop webview must advertise its zoom path before retiring the old control.
  if (
    embed ||
    isNativeWebChromeHost() ||
    "__TAURI_INTERNALS__" in window ||
    (window as NativeContentZoomWindow).chrome?.webview ||
    document.documentElement.classList.contains("openclaw-native-desktop")
  ) {
    return false;
  }
  // A secondary mouse does not give touch/tablet browsers desktop zoom parity.
  // Keep their accessibility control unless the host explicitly supplies zoom.
  return navigator.maxTouchPoints > 0
    ? false
    : (window.matchMedia?.(HOST_CONTENT_ZOOM_MEDIA_QUERY).matches ?? false);
}
