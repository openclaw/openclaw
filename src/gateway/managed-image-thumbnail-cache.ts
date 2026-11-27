import { readFileHandleBounded } from "@openclaw/fs-safe/advanced";
import { detectMime } from "@openclaw/media-core/mime";
import pLimit from "p-limit";
import type { openLocalFileSafely } from "../infra/fs-safe.js";
import { LruCache } from "../infra/lru-cache.js";
import {
  isAnimatedWebpBuffer,
  isStillPngBuffer,
  readImageProbeFromHeader,
} from "../media/image-ops.js";
import { createImageProcessor } from "../media/image-processor.js";
import {
  CHAT_IMAGE_RENDITION_MAX_BYTES,
  DEFAULT_CHAT_IMAGE_RENDITION_WIDTH,
  type ChatImageRenditionWidth,
} from "../shared/chat-image-renditions.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

export type ManagedImageThumbnail = {
  data: Buffer;
  extension: ".jpg" | ".webp";
  mimeType: "image/jpeg" | "image/webp";
};

export async function encodeImageThumbnail(
  source: Uint8Array,
  width: ChatImageRenditionWidth = DEFAULT_CHAT_IMAGE_RENDITION_WIDTH,
): Promise<ManagedImageThumbnail> {
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const format = readImageProbeFromHeader(buffer)?.format;
  const heifMime = format === "heif" ? await detectMime({ buffer }) : undefined;
  const stillHeif = heifMime === "image/heic" || heifMime === "image/heif";
  // A single-frame transform must not silently discard animation or HEIF sequences.
  const still =
    (format === "png" && isStillPngBuffer(buffer)) ||
    format === "jpeg" ||
    stillHeif ||
    (format === "webp" && !isAnimatedWebpBuffer(buffer));
  if (!still) {
    throw new Error("Managed image thumbnail is unavailable for this image format");
  }
  const maxBytes = CHAT_IMAGE_RENDITION_MAX_BYTES[width];
  const processor = createImageProcessor();
  const resize = { maxSide: width, enlarge: false };
  if (!stillHeif) {
    const webp = await processor.encode(source, { format: "webp", resize });
    if (webp.bytes <= maxBytes) {
      return { data: webp.data, extension: ".webp", mimeType: "image/webp" };
    }
  }
  // JPEG can trade quality for detail without an external WebP codec.
  // Keep alpha when the image cannot be represented as JPEG.
  const budget = { resize, maxBytes, search: { maxSide: [width, width / 2, width / 4] } };
  const thumbnail = stillHeif
    ? await processor.encode(source, { ...budget, format: "jpeg" })
    : await processor.encode(source, {
        ...budget,
        format: "auto",
        opaque: { format: "jpeg" },
        transparent: { format: "webp" },
        transparency: "preserve",
      });
  // Rastermill returns its smallest candidate even when no candidate fits.
  if (thumbnail.data.byteLength > maxBytes) {
    throw new Error("Managed image thumbnail exceeds the preview byte limit");
  }
  return thumbnail.format === "jpeg"
    ? { data: thumbnail.data, extension: ".jpg", mimeType: "image/jpeg" }
    : { data: thumbnail.data, extension: ".webp", mimeType: "image/webp" };
}

const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES = 128;
const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MANAGED_IMAGE_THUMBNAIL_MAX_PENDING = 128;
const managedImageThumbnailCache = new LruCache<ManagedImageThumbnail>(
  MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES,
  {
    maxBytes: MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES,
    sizeOf: (thumbnail) => thumbnail.data.byteLength,
  },
);
const managedImageThumbnailJobs = new Map<string, Promise<ManagedImageThumbnail>>();
const limitManagedImageThumbnails = pLimit(4);

export async function resolveManagedImageThumbnail(
  cacheKey: string,
  create: () => Promise<ManagedImageThumbnail>,
): Promise<ManagedImageThumbnail> {
  const cached = managedImageThumbnailCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  return await getOrCreatePromise(
    managedImageThumbnailJobs,
    cacheKey,
    () => {
      if (limitManagedImageThumbnails.pendingCount >= MANAGED_IMAGE_THUMBNAIL_MAX_PENDING) {
        throw new Error("managed image thumbnail queue is full");
      }
      return limitManagedImageThumbnails(create).then((thumbnail) => {
        managedImageThumbnailCache.set(cacheKey, thumbnail);
        return thumbnail;
      });
    },
    { evictOnSettled: true },
  );
}

export async function readImageThumbnailFromFile(
  opened: Awaited<ReturnType<typeof openLocalFileSafely>>,
  maxBytes?: number,
  width: ChatImageRenditionWidth = DEFAULT_CHAT_IMAGE_RENDITION_WIDTH,
): Promise<ManagedImageThumbnail> {
  if (maxBytes !== undefined && opened.stat.size > maxBytes) {
    throw new Error("Managed image exceeds the preview byte limit");
  }
  const { dev, ino } = opened.exactIdentity;
  const cacheKey = `${opened.realPath}\0${dev}:${ino}\0${opened.stat.ctimeMs}\0${opened.stat.mtimeMs}\0${opened.stat.size}\0${width}`;
  return await resolveManagedImageThumbnail(cacheKey, async () => {
    const source = await readFileHandleBounded(opened.handle, maxBytes ?? Infinity);
    return await encodeImageThumbnail(source, width);
  });
}
