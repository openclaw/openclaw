import { isIP } from "node:net";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { fileTypeFromBuffer } from "file-type";
import { Parser } from "htmlparser2";
import pLimit from "p-limit";
import { withResponseBodyTimeout } from "../infra/http-response-body-timeout.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "../infra/net/fetch-guard.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { createImageProcessor, readImageMetadataFromHeader } from "../media/image-ops.js";
import type { ControlUiLinkPreview } from "./control-ui-contract.js";

const HTML_MAX_BYTES = 64 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const ICON_MAX_BYTES = 64 * 1024;
const IMAGE_OUTPUT_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const PREVIEW_TIMEOUT_MS = 15_000;
const CACHE_MAX_ENTRIES = 64;
const SUCCESS_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const loads = pLimit(4);
const processor = createImageProcessor();
const cache = new Map<string, { expiresAt: number; promise: Promise<ControlUiLinkPreview> }>();

/** Public presentation only: never reuse browser credentials or private-network policy. */
export function parseControlUiLinkPreviewUrl(value: unknown, base?: string): URL | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    return null;
  }
  const url = URL.parse(value, base);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    isIP(normalizeHostname(url.hostname)) ||
    isBlockedHostnameOrIp(url.hostname)
  ) {
    return null;
  }
  url.hash = "";
  return url;
}

async function readPageMetadata(response: Response, finalUrl: string, signal: AbortSignal) {
  const metadata = new Map<string, string>();
  const links: Record<string, string>[] = [];
  let baseHref: string | undefined;
  let titleText: string | undefined;
  let inTitle = false;
  let finished = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "body") {
        finished = true;
        parser.pause();
      } else if (name === "base") {
        baseHref ??= attrs.href;
      } else if (name === "title" && titleText === undefined) {
        titleText = "";
        inTitle = true;
      } else if (name === "meta") {
        const key = (attrs.property ?? attrs.name)?.toLowerCase();
        const value = attrs.content?.trim();
        if (key && value && !metadata.has(key)) {
          metadata.set(key, value);
        }
      } else if (name === "link") {
        links.push(attrs);
      }
    },
    ontext(text) {
      if (inTitle) {
        titleText += text;
      }
    },
    onclosetag(name) {
      if (name === "title") {
        inTitle = false;
      } else if (name === "head") {
        finished = true;
        parser.pause();
      }
    },
  });
  const reader = response.body?.getReader();
  if (reader) {
    try {
      await withResponseBodyTimeout({
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        onTimeout: undefined,
        cancel: (error) => reader.cancel(error),
        read: async (refreshTimeout) => {
          const decoder = new TextDecoder();
          let remaining = HTML_MAX_BYTES;
          while (remaining > 0) {
            refreshTimeout?.();
            const { done, value } = await reader.read();
            if (done) {
              parser.end(decoder.decode());
              return;
            }
            const chunk = value.subarray(0, remaining);
            remaining -= chunk.byteLength;
            parser.write(decoder.decode(chunk, { stream: true }));
            if (finished) {
              return;
            }
          }
          parser.end();
        },
      });
    } finally {
      // Do not await cancellation: a response-capture tee may still own its other branch.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  // Resolve after parsing: the first base can follow the metadata it governs.
  const baseUrl = URL.parse(baseHref ?? "", finalUrl)?.href ?? finalUrl;
  const title = metadata.get("og:title") ?? metadata.get("twitter:title") ?? titleText;
  const description =
    metadata.get("og:description") ??
    metadata.get("twitter:description") ??
    metadata.get("description");
  const image = [
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  ]
    .map((key) => parseControlUiLinkPreviewUrl(metadata.get(key), baseUrl)?.href)
    .find(Boolean);
  const icons: string[] = [];
  for (const attrs of links) {
    const rel = attrs.rel?.toLowerCase().split(/\s+/u) ?? [];
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) {
      continue;
    }
    const url = parseControlUiLinkPreviewUrl(attrs.href, baseUrl)?.href;
    // The presentation contract carries raster/ICO only; unsupported vectors fall back to /favicon.ico.
    if (url && attrs.type !== "image/svg+xml" && !icons.includes(url)) {
      icons.push(url);
      if (icons.length === 2) {
        break;
      }
    }
  }
  return {
    title: title ? truncateUtf16Safe(title.replace(/\s+/gu, " ").trim(), 180) : undefined,
    description: description
      ? truncateUtf16Safe(description.replace(/\s+/gu, " ").trim(), 400)
      : undefined,
    image,
    icons,
  };
}

async function fetchPreviewResource<T>(
  url: string,
  accept: string,
  signal: AbortSignal,
  isEnabled: () => boolean,
  read: (response: Response, finalUrl: string) => Promise<T>,
): Promise<T | undefined> {
  try {
    const { response, finalUrl, release } = await fetchWithSsrFGuard(
      withStrictGuardedFetchMode({
        url,
        maxRedirects: 3,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal,
        init: { headers: { Accept: accept }, credentials: "omit" },
        // This callback runs after DNS/transport preparation, immediately before every hop.
        beforeRequest: () => {
          signal.throwIfAborted();
          if (!isEnabled()) {
            throw new Error("Link previews disabled");
          }
        },
        // Preserve the anonymous public URL contract on redirects as well as initial requests.
        resolveDispatcherPolicy: (target) => {
          if (!parseControlUiLinkPreviewUrl(target.href)) {
            throw new Error("Not a public preview URL");
          }
          return undefined;
        },
      }),
    );
    try {
      return response.ok ? await read(response, finalUrl) : undefined;
    } finally {
      await release();
    }
  } catch {
    // Presentation failure never turns a usable browser-tab link into a failed tool result.
    return undefined;
  }
}

async function loadImage(
  url: string,
  icon: boolean,
  signal: AbortSignal,
  isEnabled: () => boolean,
) {
  return await fetchPreviewResource(url, "image/*", signal, isEnabled, async (response) => {
    const bytes = await readResponseWithLimit(response, icon ? ICON_MAX_BYTES : IMAGE_MAX_BYTES, {
      signal,
      chunkTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const detected = await fileTypeFromBuffer(bytes);
    if (icon && detected?.mime === "image/x-icon") {
      return `data:image/x-icon;base64,${bytes.toString("base64")}`;
    }
    if (
      !detected ||
      !["image/png", "image/apng", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(
        detected.mime,
      )
    ) {
      return undefined;
    }
    const size = readImageMetadataFromHeader(bytes);
    if (!size || size.width <= 0 || size.height <= 0 || size.width > 16_000_000 / size.height) {
      return undefined;
    }
    const result = await processor.encode(bytes, {
      format: "png",
      resize: { maxSide: icon ? 64 : 640, fit: "inside", enlarge: false },
      signal,
    });
    return result.data.length <= (icon ? ICON_MAX_BYTES : IMAGE_OUTPUT_MAX_BYTES)
      ? `data:image/png;base64,${result.data.toString("base64")}`
      : undefined;
  });
}

async function loadPreview(url: URL, isEnabled: () => boolean): Promise<ControlUiLinkPreview> {
  const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
  const page = await fetchPreviewResource(
    url.href,
    "text/html,application/xhtml+xml",
    signal,
    isEnabled,
    async (response, finalUrl) => {
      const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "text/html" && type !== "application/xhtml+xml") {
        return undefined;
      }
      return { ...(await readPageMetadata(response, finalUrl, signal)), finalUrl };
    },
  );
  const iconUrls = new Set([
    ...(page?.icons ?? []),
    new URL("/favicon.ico", page?.finalUrl ?? url.href).href,
  ]);
  const [imageDataUrl, faviconDataUrl] = await Promise.all([
    page?.image ? loadImage(page.image, false, signal, isEnabled) : undefined,
    (async () => {
      for (const iconUrl of iconUrls) {
        const icon = await loadImage(iconUrl, true, signal, isEnabled);
        if (icon) {
          return icon;
        }
      }
      return undefined;
    })(),
  ]);
  return isEnabled()
    ? {
        ...(page?.title ? { title: page.title } : {}),
        ...(page?.description ? { description: page.description } : {}),
        ...(imageDataUrl ? { imageDataUrl } : {}),
        ...(faviconDataUrl ? { faviconDataUrl } : {}),
      }
    : {};
}

/** Anonymous bounded cache: no user, browser-profile, cookie, or authentication state enters it. */
export async function loadControlUiLinkPreview(
  url: URL,
  isEnabled: () => boolean,
): Promise<ControlUiLinkPreview> {
  const target = parseControlUiLinkPreviewUrl(url.href);
  if (!isEnabled() || !target) {
    return {};
  }
  const now = Date.now();
  const existing = cache.get(target.href);
  if (existing && existing.expiresAt > now) {
    const result = await existing.promise;
    return isEnabled() ? result : {};
  }
  if (loads.activeCount + loads.pendingCount >= 32) {
    return {};
  }
  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: loads(() => loadPreview(target, isEnabled)).catch(() => ({})),
  };
  cache.delete(target.href);
  cache.set(target.href, entry);
  pruneMapToMaxSize(cache, CACHE_MAX_ENTRIES);
  const result = await entry.promise;
  entry.expiresAt = Date.now() + (Object.keys(result).length ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
  return isEnabled() ? result : {};
}
