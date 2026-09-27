import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NATIVE_HISTORY_STATE_EVENT = "openclaw:native-history-state";
export const NATIVE_PRESENTATION_REQUEST_EVENT = "openclaw:native-presentation-request";

export type NativePresentationState = {
  generation: number;
  phase: "loading" | "ready";
  pathname: string;
  search: string;
  hash: string;
};

export type NativeHistoryState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type NativeEmbedHost = {
  platform: "ios" | "macos" | "android" | "windows" | "linux";
  formFactor: "phone" | "pad" | "desktop";
  navigationChrome?: "host";
};

type NativePanelBridge = { postMessage(message: unknown): void };

type NativeWebChromeWindow = Window & {
  __OPENCLAW_NATIVE_EMBED__?: unknown;
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: NativeHistoryState;
  __OPENCLAW_NATIVE_PANEL__?: NativePanelBridge;
};

// Hosts listen from document start so they can enable the shared chrome before
// application state reads their flag or the first shell renders.
if (typeof window !== "undefined") {
  window.dispatchEvent(new Event("openclaw:native-window-chrome-available"));
}

export function isNativeWebChromeHost(): boolean {
  return (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] === true;
}

export function nativePanelBridge(): NativePanelBridge | null {
  // SAFETY: the native host adds this optional bridge; validate postMessage before use.
  const bridge = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_PANEL__"];
  return typeof bridge?.postMessage === "function" ? bridge : null;
}

export function nativeEmbedHost(): NativeEmbedHost | null {
  // SAFETY: the host adds this optional document-start value; its shape is validated below.
  const host = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_EMBED__"];
  if (!isRecord(host)) {
    return null;
  }
  const { platform, formFactor } = host;
  return (platform === "ios" ||
    platform === "macos" ||
    platform === "android" ||
    platform === "windows" ||
    platform === "linux") &&
    (formFactor === "phone" || formFactor === "pad" || formFactor === "desktop")
    ? {
        platform,
        formFactor,
        ...(host.navigationChrome === "host" ? { navigationChrome: "host" } : {}),
      }
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
