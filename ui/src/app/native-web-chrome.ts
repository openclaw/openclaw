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

declare global {
  interface Window {
    __OPENCLAW_NATIVE_EMBED__?: unknown;
    __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
    __OPENCLAW_NATIVE_CONTROL_UI_CACHE_POLICY__?: "reload";
    __OPENCLAW_NATIVE_HISTORY__?: NativeHistoryState;
  }
}

// Hosts listen from document start so they can enable the shared chrome before
// application state reads their flag or the first shell renders.
if (typeof window !== "undefined") {
  window.dispatchEvent(new Event("openclaw:native-window-chrome-available"));
}

export function isNativeWebChromeHost(): boolean {
  return window["__OPENCLAW_NATIVE_WEB_CHROME__"] === true;
}

export function shouldRegisterControlUiServiceWorker(isProd: boolean): boolean {
  return isProd && !usesNativeControlUiCachePolicy();
}

function usesNativeControlUiCachePolicy(): boolean {
  return window["__OPENCLAW_NATIVE_CONTROL_UI_CACHE_POLICY__"] === "reload";
}

export function isOwnedControlUiServiceWorkerRegistration(
  registration: ServiceWorkerRegistration,
  controlUiWorkerUrl: URL,
  pageUrl: URL,
): boolean {
  let scopeUrl: URL;
  try {
    scopeUrl = new URL(registration.scope);
  } catch {
    return false;
  }
  const pagePath = pageUrl.pathname;
  const scopePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
  const scopeCoversPage = pagePath === scopeUrl.pathname || pagePath.startsWith(scopePath);
  if (scopeUrl.origin !== controlUiWorkerUrl.origin || !scopeCoversPage) {
    return false;
  }
  return [registration.installing, registration.waiting, registration.active].some((worker) => {
    if (!worker) {
      return false;
    }
    try {
      const scriptUrl = new URL(worker.scriptURL);
      return (
        scriptUrl.origin === controlUiWorkerUrl.origin &&
        scriptUrl.pathname === controlUiWorkerUrl.pathname
      );
    } catch {
      return false;
    }
  });
}

export function nativeEmbedHost(): NativeEmbedHost | null {
  // SAFETY: the host adds this optional document-start value; its shape is validated below.
  const host = window["__OPENCLAW_NATIVE_EMBED__"];
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
  const state = window["__OPENCLAW_NATIVE_HISTORY__"];
  return state && typeof state.canGoBack === "boolean" && typeof state.canGoForward === "boolean"
    ? state
    : { canGoBack: false, canGoForward: false };
}
