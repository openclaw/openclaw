/**
 * Canonical native browser bridge (macOS and Tauri hosts mirror these keys).
 * Handler: window.webkit.messageHandlers.openclawBrowser, Promise reply {ok:true,...}
 * or {ok:false,error}. Requests use type: open {tabId,url,sessionKey,activate?}, navigate
 * {tabId,url}, back/forward/reload/stop/close/snapshot/download {tabId}, inspect {tabId,x,y},
 * present {scope,tabId,rect:{x,y,width,height}|null,visible}, release-scope {scope}.
 * IDs and scopes are opaque; web-created IDs are `mac-` plus a generated UUID.
 * Open replies include tabId. The host reuses a session's tab at the requested URL or its
 * retained initial-request alias, so the returned ID may differ from the request.
 * The requesting panel selects that returned tab; it need not wait for a new tab.
 * Rects are dashboard viewport CSS pixels. Null tab/rect or invisible hides a scope.
 * The window retains session-owned tabs; empty sessionKey is the non-chat dock.
 * Popups inherit their opener's session. Release-scope never closes tabs. If scopes present the
 * same tab, the most recent presentation wins until it is hidden or released.
 * Push: __OPENCLAW_NATIVE_BROWSER__ plus openclaw:native-browser-state detail,
 * {revision,tabs:[{id,sessionKey?,url,title,loading,canGoBack,canGoForward,openedBy,openerTabId?,favicon?}]}.
 * Released Mac apps omit sessionKey; these legacy tabs remain window-shared.
 * Keep this bridge transition until supported app/UI releases all carry session keys.
 * Tabs are in creation order; openedBy is web|native. Snapshot adds dataUrl (PNG),
 * cssWidth,cssHeight; inspect adds node (BrowserInspectedNode|null).
 * Download saves the current tab through its native host, preserving its browser session;
 * its reply adds cancelled (true when the save panel was dismissed).
 */
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import type { BrowserInspectedNode } from "../components/browser/browser-client.ts";
import { listen } from "../lib/reactive/listener.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";

export { hasNativeBrowserBridge } from "./native-browser-host.ts";

export type NativeBrowserTab = {
  id: string;
  sessionKey?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  openedBy: "web" | "native";
  openerTabId?: string;
  favicon?: string;
};
export type NativeBrowserState = { revision: number; tabs: NativeBrowserTab[] };
type NativeBrowserRect = { x: number; y: number; width: number; height: number };
export type NativeBrowserMessage =
  | { type: "open"; tabId: string; url: string; sessionKey: string; activate?: boolean }
  | { type: "navigate"; tabId: string; url: string }
  | {
      type: "back" | "forward" | "reload" | "stop" | "close" | "snapshot" | "download";
      tabId: string;
    }
  | { type: "inspect"; tabId: string; x: number; y: number }
  | {
      type: "present";
      scope: string;
      tabId: string | null;
      rect: NativeBrowserRect | null;
      visible: boolean;
    }
  | { type: "release-scope"; scope: string };
export type NativeBrowserReply =
  | {
      ok: true;
      tabId?: string;
      cancelled?: boolean;
      dataUrl?: string;
      cssWidth?: number;
      cssHeight?: number;
      node?: BrowserInspectedNode | null;
    }
  | { ok: false; error: string };

type NativeBrowserWindow = Window & {
  __OPENCLAW_NATIVE_BROWSER__?: unknown;
  webkit?: {
    messageHandlers?: {
      openclawBrowser?: { postMessage(message: NativeBrowserMessage): Promise<unknown> };
    };
  };
};
const STATE_EVENT = "openclaw:native-browser-state";
type StateSubscription = { revision: number; listener: (state: NativeBrowserState) => void };
type StatePool = { subscribers: Set<StateSubscription>; stop: () => void };
const statePools = new WeakMap<Window, StatePool>();

function nativeWindow(): NativeBrowserWindow | undefined {
  return typeof window === "undefined" ? undefined : window;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function sessionKey(value: unknown): value is string {
  return value === "" || nonempty(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function browserUrl(value: unknown): value is string {
  return typeof value === "string" && (value === "about:blank" || isHttpUrl(value));
}
function isRect(value: unknown): value is NativeBrowserRect {
  return (
    isRecord(value) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    value.width >= 0 &&
    finite(value.height) &&
    value.height >= 0
  );
}
function isState(value: unknown): value is NativeBrowserState {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 0 ||
    !Array.isArray(value.tabs)
  ) {
    return false;
  }
  const ids = new Set<string>();
  return Array.from(value.tabs).every((tab: unknown) => {
    if (
      !isRecord(tab) ||
      !nonempty(tab.id) ||
      (tab.sessionKey !== undefined && !sessionKey(tab.sessionKey)) ||
      ids.has(tab.id) ||
      !browserUrl(tab.url) ||
      typeof tab.title !== "string" ||
      (tab.favicon !== undefined &&
        (typeof tab.favicon !== "string" ||
          tab.favicon.length > 98_304 ||
          !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(tab.favicon))) ||
      typeof tab.loading !== "boolean" ||
      typeof tab.canGoBack !== "boolean" ||
      typeof tab.canGoForward !== "boolean" ||
      (tab.openedBy !== "web" && tab.openedBy !== "native") ||
      (tab.openerTabId !== undefined && !nonempty(tab.openerTabId))
    ) {
      return false;
    }
    ids.add(tab.id);
    return true;
  });
}
function isNode(value: unknown): value is BrowserInspectedNode | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.tag === "string" &&
      typeof value.id === "string" &&
      isStringArray(value.classes) &&
      typeof value.role === "string" &&
      typeof value.name === "string" &&
      typeof value.focusable === "boolean" &&
      isRect(value.rect))
  );
}

export async function postNativeBrowserMessage(
  message: NativeBrowserMessage,
): Promise<NativeBrowserReply | null> {
  const bridge = nativeWindow()?.webkit?.messageHandlers?.openclawBrowser;
  if (typeof bridge?.postMessage !== "function") {
    return null;
  }
  try {
    // Native hosts validate requests at the effect; malformed internal calls return their error.
    const post = bridge.postMessage.bind(bridge);
    const reply = await post(message);
    if (isRecord(reply) && reply.ok === false && typeof reply.error === "string") {
      return { ok: false, error: reply.error };
    }
    if (!isRecord(reply) || reply.ok !== true) {
      return { ok: false, error: "Invalid native browser reply" };
    }
    if (message.type === "open") {
      return nonempty(reply.tabId)
        ? { ok: true, tabId: reply.tabId }
        : { ok: false, error: "Invalid native browser reply" };
    }
    if (message.type === "download") {
      return typeof reply.cancelled === "boolean"
        ? { ok: true, cancelled: reply.cancelled }
        : { ok: false, error: "Invalid native browser download" };
    }
    if (message.type === "snapshot") {
      if (
        typeof reply.dataUrl !== "string" ||
        !reply.dataUrl.startsWith("data:image/png;base64,") ||
        !finite(reply.cssWidth) ||
        reply.cssWidth <= 0 ||
        !finite(reply.cssHeight) ||
        reply.cssHeight <= 0
      ) {
        return { ok: false, error: "Invalid native browser snapshot" };
      }
      return {
        ok: true,
        dataUrl: reply.dataUrl,
        cssWidth: reply.cssWidth,
        cssHeight: reply.cssHeight,
      };
    }
    if (message.type === "inspect") {
      return isNode(reply.node)
        ? { ok: true, node: reply.node }
        : { ok: false, error: "Invalid native browser inspection" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Native browser request failed",
    };
  }
}
export function readNativeBrowserState(): NativeBrowserState | null {
  if (!hasNativeBrowserBridge()) {
    return null;
  }
  const value = nativeWindow()?.["__OPENCLAW_NATIVE_BROWSER__"];
  return isState(value) ? value : null;
}
export function subscribeNativeBrowserState(
  listener: (state: NativeBrowserState) => void,
): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  let pool = statePools.get(window);
  if (!pool) {
    const subscribers = new Set<StateSubscription>();
    pool = {
      subscribers,
      stop: listen(window, STATE_EVENT, (event) => {
        const state: unknown = event instanceof CustomEvent ? event.detail : null;
        if (!isState(state)) {
          return;
        }
        const delivery = [...subscribers];
        for (const subscriber of delivery) {
          if (!subscribers.has(subscriber) || state.revision <= subscriber.revision) {
            continue;
          }
          subscriber.revision = state.revision;
          try {
            subscriber.listener(state);
          } catch (error) {
            // Native dispatch isolates listeners; sharing must preserve that boundary.
            reportError(error);
          }
        }
      }),
    };
    statePools.set(window, pool);
  }
  const subscription = { revision: readNativeBrowserState()?.revision ?? -1, listener };
  pool.subscribers.add(subscription);
  return () => {
    if (!pool.subscribers.delete(subscription)) {
      return;
    }
    if (pool.subscribers.size === 0) {
      pool.stop();
      statePools.delete(window);
    }
  };
}
