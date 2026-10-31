import { BROWSER_IMAGE_MIME_TYPES } from "../../../src/shared/browser-image-mime-types.js";
import { downloadBlobFile } from "../lib/download.ts";
import { downloadImageBlob } from "../lib/image-download.ts";
import { resolveSafeExternalUrl } from "../lib/open-external-url.ts";

export function externalLightboxImageUrl(image: { src: string; originalSrc?: string }): string {
  const safe = resolveSafeExternalUrl(image.originalSrc || image.src, location.href);
  if (!safe) {
    return "";
  }
  const url = new URL(safe);
  // External hosts may display in IMG while disallowing CORS blob downloads.
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== location.origin
    ? url.href
    : "";
}

function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export async function resolveLightboxOriginalUrl(
  source: string,
  current: () => boolean,
): Promise<{ url: string; blobUrl?: string } | null> {
  if (!source) {
    return null;
  }
  const prefix = source.slice(0, 5).toLowerCase();
  if (prefix !== "data:" && prefix !== "blob:") {
    return { url: source };
  }
  const mediaType = prefix === "data:" ? /^data:([^,]*)/i.exec(source)?.[1] : undefined;
  const sourceType = mediaType === undefined ? undefined : mimeTypeEssence(mediaType);
  // Top-level active blobs inherit the app origin; only browser image MIME is safe.
  if (prefix === "data:" && (!sourceType || !BROWSER_IMAGE_MIME_TYPES.has(sourceType))) {
    return null;
  }
  const response = await fetch(source);
  const blob = await response.blob();
  if (!current() || !BROWSER_IMAGE_MIME_TYPES.has(mimeTypeEssence(blob.type))) {
    return null;
  }
  if (prefix === "blob:") {
    return { url: source };
  }
  const blobUrl = URL.createObjectURL(blob);
  return { url: blobUrl, blobUrl };
}

export async function downloadLightboxImage(
  source: string,
  title: string,
  read?: () => Promise<Blob>,
) {
  const blob = read
    ? await read()
    : await fetch(source).then((response) => {
        if (!response.ok) {
          throw new Error("Image download failed");
        }
        return response.blob();
      });
  const mimeType = mimeTypeEssence(blob.type);
  if (mimeType === "image/svg+xml") {
    // Preserve the original file without creating an active SVG download URL.
    downloadBlobFile(title, new Blob([blob], { type: "application/octet-stream" }), 30_000);
    return;
  }
  if (!BROWSER_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error("Unsupported image download");
  }
  downloadImageBlob(blob, title);
}
