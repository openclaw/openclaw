import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NATIVE_HISTORY_STATE_EVENT = "openclaw:native-history-state";

export type NativeHistoryState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type NativeEmbedHost = {
  platform: "ios" | "macos" | "android";
  formFactor: "phone" | "pad" | "desktop";
};

type NativeWebChromeWindow = Window & {
  __OPENCLAW_NATIVE_EMBED__?: unknown;
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: NativeHistoryState;
};

export function isNativeWebChromeHost(): boolean {
  return (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] === true;
}

export function nativeEmbedHost(): NativeEmbedHost | null {
  // SAFETY: the host adds this optional document-start value; its shape is validated below.
  const host = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_EMBED__"];
  if (!isRecord(host)) {
    return null;
  }
  const { platform, formFactor } = host;
  return (platform === "ios" || platform === "macos" || platform === "android") &&
    (formFactor === "phone" || formFactor === "pad" || formFactor === "desktop")
    ? { platform, formFactor }
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
