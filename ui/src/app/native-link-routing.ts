import type { NativeLinkMenu } from "../components/native-link-menu.runtime.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import {
  anchorFromNavigationEvent,
  externalHttpLinkFromEvent,
  shouldHandleNavigationClick,
} from "../lib/navigation-click.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";
import { webKitHostWindow, type WebKitHostMessages } from "./native-webkit-bridge.ts";

type NativeLinkPoster = (message: WebKitHostMessages["openclawLink"]) => void;

const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
export const NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT =
  "openclaw:native-update-availability-changed";
const NATIVE_UPDATE_POSTED_EVENT = "openclaw:native-update-posted";

type NativeLinkRouting = {
  dispose(): void;
};

type NativeLinkRoutingOptions = {
  signal?: AbortSignal;
  onNativeUpdateDeclined?: () => void;
  shouldOpenInControlUiBrowser?: () => boolean;
  canPresentBrowserPanel?: () => boolean;
};

function getNativeLinkPoster(): NativeLinkPoster | undefined {
  // Native hosts install this handler before navigation; its absence preserves browser behavior.
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawLink;
  return handler?.postMessage.bind(handler);
}

function getNativeUpdateHandler() {
  return webKitHostWindow()?.webkit?.messageHandlers?.openclawUpdate;
}

export function hasNativeUpdateBridge(): boolean {
  return getNativeUpdateHandler() !== undefined;
}

export function postNativeUpdate(): boolean {
  const handler = getNativeUpdateHandler();
  if (!handler) {
    return false;
  }
  // Bound single-argument WebKit handler call, not window.postMessage;
  // binding also keeps oxlint's targetOrigin rule out of the wrong context.
  const poster = handler.postMessage.bind(handler);
  poster({ type: "start-update" });
  window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_POSTED_EVENT));
  return true;
}

function trustedExternalAppUrl(event: MouseEvent): { anchor: HTMLAnchorElement; url: URL } | null {
  if (!event.isTrusted) {
    return null;
  }
  const anchor = anchorFromNavigationEvent(event);
  if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("data-file-path")) {
    return null;
  }
  try {
    const url = new URL(anchor.href, window.location.href);
    return url.protocol === "mailto:" || url.protocol === "tel:" ? { anchor, url } : null;
  } catch {
    return null;
  }
}

function postNativeLink(postMessage: NativeLinkPoster, url: URL): boolean {
  try {
    postMessage({ type: "open-link", url: url.href, target: "external" });
    return true;
  } catch {
    return false;
  }
}

export function postNativeExternalLink(url: string): boolean {
  const poster = getNativeLinkPoster();
  if (!poster) {
    return false;
  }
  try {
    return postNativeLink(poster, new URL(url));
  } catch {
    return false;
  }
}

function openBrowserPanel(url: URL): void {
  window.dispatchEvent(
    new CustomEvent<BrowserPanelToggleDetail>(BROWSER_PANEL_TOGGLE_EVENT, {
      detail: { open: true, url: url.href, ...(hasNativeBrowserBridge() ? { native: true } : {}) },
    }),
  );
}

function shouldHandleControlUiBrowserActivation(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.shiftKey &&
    !event.altKey &&
    ((event.type === "click" && event.button === 0) ||
      (event.type === "auxclick" && event.button === 1))
  );
}

export function startNativeLinkRouting(options: NativeLinkRoutingOptions = {}): NativeLinkRouting {
  if (options.signal?.aborted || typeof window === "undefined" || typeof document === "undefined") {
    return { dispose() {} };
  }
  const postMessage = getNativeLinkPoster();
  if (
    !postMessage &&
    !hasNativeBrowserBridge() &&
    !options.shouldOpenInControlUiBrowser &&
    !options.onNativeUpdateDeclined
  ) {
    return { dispose() {} };
  }
  let menu: NativeLinkMenu | null = null;
  let menuModule: Promise<typeof import("../components/native-link-menu.runtime.ts")> | undefined;
  let menuRequest = 0;
  let disposed = false;
  let nativeUpdatePending = false;
  const handleNativeUpdatePosted = () => {
    nativeUpdatePending = true;
  };
  const handleNativeUpdateDeclined = () => {
    if (!nativeUpdatePending) {
      return;
    }
    nativeUpdatePending = false;
    options.onNativeUpdateDeclined?.();
  };
  const closeMenu = (expected?: NativeLinkMenu) => {
    if (expected && menu !== expected) {
      return;
    }
    menuRequest += 1;
    menu?.remove();
    menu = null;
  };
  const openInline = (url: URL) => {
    if (hasNativeBrowserBridge() && options.canPresentBrowserPanel?.() === false) {
      if (postMessage) {
        postNativeLink(postMessage, url);
      }
    } else {
      openBrowserPanel(url);
    }
  };
  const showMenu = async (event: MouseEvent, anchor: HTMLAnchorElement, url: URL) => {
    closeMenu();
    const request = menuRequest;
    const path = event.composedPath();
    const { mountNativeLinkMenu } = await (menuModule ??=
      import("../components/native-link-menu.runtime.ts"));
    if (disposed || options.signal?.aborted || request !== menuRequest || !anchor.isConnected) {
      return;
    }
    menu = mountNativeLinkMenu({
      path,
      anchor,
      url,
      x: event.clientX,
      y: event.clientY,
      close: closeMenu,
      openExternal: () => postMessage && postNativeLink(postMessage, url),
      openInline: () => openInline(url),
    });
  };

  const handleClick = (event: MouseEvent) => {
    const webLink = externalHttpLinkFromEvent(event);
    // The reader's escape hatch must bypass both native and preferred in-app browsers.
    if (webLink?.anchor.hasAttribute("data-link-reader-external")) {
      if (
        postMessage &&
        shouldHandleNavigationClick(event) &&
        postNativeLink(postMessage, webLink.url)
      ) {
        closeMenu();
        event.preventDefault();
      }
      return;
    }
    if (
      webLink &&
      (hasNativeBrowserBridge()
        ? shouldHandleNavigationClick(event)
        : shouldHandleControlUiBrowserActivation(event)) &&
      (hasNativeBrowserBridge() || options.shouldOpenInControlUiBrowser?.())
    ) {
      openInline(webLink.url);
      closeMenu();
      event.preventDefault();
      return;
    }
    if (!postMessage || !shouldHandleNavigationClick(event)) {
      return;
    }
    const appLink = trustedExternalAppUrl(event);
    if (!appLink || !postNativeLink(postMessage, appLink.url)) {
      return;
    }
    closeMenu();
    event.preventDefault();
  };
  const handleContextMenu = (event: MouseEvent) => {
    if (!postMessage || event.defaultPrevented) {
      return;
    }
    const link = externalHttpLinkFromEvent(event);
    if (!link) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void showMenu(event, link.anchor, link.url).catch((error: unknown) => {
      menuModule = undefined;
      if (!disposed) {
        console.error("[openclaw] native link menu failed to load; right-click to retry", error);
      }
    });
  };

  // Run after target/document handlers so cancelled application actions remain authoritative.
  window.addEventListener("click", handleClick);
  window.addEventListener("auxclick", handleClick);
  window.addEventListener(NATIVE_UPDATE_POSTED_EVENT, handleNativeUpdatePosted);
  window.addEventListener(NATIVE_UPDATE_DECLINED_EVENT, handleNativeUpdateDeclined);
  // Capture keeps message-level context menus from replacing native link actions.
  if (postMessage) {
    document.addEventListener("contextmenu", handleContextMenu, true);
  }

  const dispose = () => {
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    window.removeEventListener("click", handleClick);
    window.removeEventListener("auxclick", handleClick);
    window.removeEventListener(NATIVE_UPDATE_POSTED_EVENT, handleNativeUpdatePosted);
    window.removeEventListener(NATIVE_UPDATE_DECLINED_EVENT, handleNativeUpdateDeclined);
    document.removeEventListener("contextmenu", handleContextMenu, true);
    closeMenu();
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  return { dispose };
}
