import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NATIVE_HISTORY_STATE_EVENT = "openclaw:native-history-state";
export const HOST_CONTENT_ZOOM_MEDIA_QUERY = "(any-hover: hover) and (any-pointer: fine)";

export type NativeHistoryState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type NativeEmbedHost = {
  platform: "ios" | "macos" | "android";
  formFactor: "phone" | "pad" | "desktop";
  surface?: "conversation";
};

type NativeWebChromeWindow = Window & {
  chrome?: { webview?: unknown };
  __OPENCLAW_NATIVE_EMBED__?: unknown;
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: NativeHistoryState;
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
  const host = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_CONTENT_ZOOM__"];
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
    (window as NativeWebChromeWindow).chrome?.webview ||
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

// Hosts listen from document start so they can enable the shared chrome before
// application state reads their flag or the first shell renders.
if (typeof window !== "undefined") {
  window.dispatchEvent(new Event("openclaw:native-window-chrome-available"));
}

export function isNativeWebChromeHost(): boolean {
  return (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] === true;
}

export function nativeEmbedHost(): NativeEmbedHost | null {
  // SAFETY: the host adds this optional document-start value; its shape is validated below.
  const host = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_EMBED__"];
  if (!isRecord(host)) {
    return null;
  }
  const { platform, formFactor, surface } = host;
  return (platform === "ios" || platform === "macos" || platform === "android") &&
    (formFactor === "phone" || formFactor === "pad" || formFactor === "desktop") &&
    (surface === undefined || surface === "conversation")
    ? { platform, formFactor, ...(surface ? { surface } : {}) }
    : null;
}

export function isNativeEmbedHost(): boolean {
  return nativeEmbedHost() !== null;
}

export function readNativeHistoryState(): NativeHistoryState {
  const state = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_HISTORY__"];
  return state && typeof state.canGoBack === "boolean" && typeof state.canGoForward === "boolean"
    ? state
    : { canGoBack: false, canGoForward: false };
}
