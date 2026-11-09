import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const DATA_URL_PREFIX = "data:";
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
const BLOCKED_DATA_IMAGE_MIME_TYPES = new Set(["image/svg+xml"]);

function isAllowedDataImageUrl(url: string): boolean {
  if (!normalizeLowercaseStringOrEmpty(url).startsWith(DATA_URL_PREFIX)) {
    return false;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < DATA_URL_PREFIX.length) {
    return false;
  }

  const metadata = url.slice(DATA_URL_PREFIX.length, commaIndex);
  const mimeType = normalizeLowercaseStringOrEmpty(metadata.split(";")[0]);
  if (!mimeType.startsWith("image/")) {
    return false;
  }

  return !BLOCKED_DATA_IMAGE_MIME_TYPES.has(mimeType);
}

type ResolveSafeExternalUrlOptions = {
  allowDataImage?: boolean;
};

export function resolveSafeExternalUrl(
  rawUrl: string,
  baseHref: string,
  opts: ResolveSafeExternalUrlOptions = {},
): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (opts.allowDataImage === true && isAllowedDataImageUrl(candidate)) {
    return candidate;
  }

  if (normalizeLowercaseStringOrEmpty(candidate).startsWith(DATA_URL_PREFIX)) {
    return null;
  }

  const parsed = URL.parse(candidate, baseHref);
  return parsed && ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
}

// Window features use CSS pixels, including on scaled and secondary displays.
// The browser constrains placement to the available work area, including its own chrome.
function centeredPopupFeatures(size: { width: number; height: number }): string {
  const width = Math.min(size.width, window.screen.availWidth);
  const height = Math.min(size.height, window.screen.availHeight);
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
  return `popup,width=${width},height=${height},left=${left},top=${top}`;
}

/** Reserves an opener-isolated window during user activation for later navigation. */
export function reserveExternalWindowForDeferredNavigation(
  opts: { popup?: boolean | { width: number; height: number } } = {},
): WindowProxy | null {
  const features =
    typeof opts.popup === "object"
      ? centeredPopupFeatures(opts.popup)
      : opts.popup
        ? "popup"
        : undefined;
  // Reserve while user activation is live, then detach the opener before any
  // caller-controlled URL can be loaded into the new browsing context.
  const opened = window.open("about:blank", "_blank", features);
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

export function openExternalUrlSafe(
  rawUrl: string,
  opts: ResolveSafeExternalUrlOptions = {},
): WindowProxy | null {
  const safeUrl = resolveSafeExternalUrl(rawUrl, window.location.href, opts);
  if (!safeUrl) {
    return null;
  }

  const opened = window.open(safeUrl, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}
