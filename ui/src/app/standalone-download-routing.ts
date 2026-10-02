import { anchorFromNavigationEvent, shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../lib/open-external-url.ts";
import { isStandaloneDisplay } from "../lib/standalone-display.ts";

const GATEWAY_FILE_ROUTE = "/__openclaw__/";

function localFileUrl(anchor: HTMLAnchorElement): URL | null {
  const href = anchor.getAttribute("href");
  if (!href) {
    return null;
  }
  try {
    const url = new URL(anchor.href, window.location.href);
    if (url.protocol === "blob:" || url.protocol === "data:") {
      return url;
    }
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === window.location.origin
      ? url
      : null;
  } catch {
    return null;
  }
}

function opensInPlace(anchor: HTMLAnchorElement): boolean {
  const target = anchor.target.trim().toLowerCase();
  return target === "" || target === "_self" || target === "_top" || target === "_parent";
}

/**
 * Keeps file links from replacing the app. A download link in a home screen
 * app saves through the share sheet; a raw gateway file link opens in a new
 * browsing context instead of the app's own window.
 */
export function startStandaloneDownloadRouting(options: { signal?: AbortSignal } = {}) {
  const handleClick = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    const url = anchor ? localFileUrl(anchor) : null;
    if (!anchor || !url) {
      return;
    }
    if (anchor.hasAttribute("download")) {
      if (!isStandaloneDisplay()) {
        return;
      }
      event.preventDefault();
      const filename = anchor.getAttribute("download") ?? undefined;
      // The save path loads on first use to keep it out of the startup bundle.
      void import("../lib/download.ts").then(({ saveStandaloneUrl }) =>
        saveStandaloneUrl(url.href, filename),
      );
      return;
    }
    const rawFile =
      url.protocol === "blob:" ||
      url.protocol === "data:" ||
      url.pathname.includes(GATEWAY_FILE_ROUTE);
    if (!rawFile || !opensInPlace(anchor) || anchor.hasAttribute("data-file-path")) {
      return;
    }
    const safeUrl = resolveSafeExternalUrl(url.href, window.location.href, {
      allowDataImage: true,
    });
    if (safeUrl) {
      event.preventDefault();
      openExternalUrlSafe(safeUrl, { allowDataImage: true });
    }
  };
  // Run after target handlers so links the app already handled stay untouched.
  window.addEventListener("click", handleClick);
  const dispose = () => {
    options.signal?.removeEventListener("abort", dispose);
    window.removeEventListener("click", handleClick);
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  return { dispose };
}
