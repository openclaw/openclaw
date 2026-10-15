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

export async function encodeImageThumbnail(
  source: Uint8Array,
  width: ChatImageRenditionWidth = DEFAULT_CHAT_IMAGE_RENDITION_WIDTH,
): Promise<Buffer> {
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const format = readImageProbeFromHeader(buffer)?.format;
  // A single-frame transform must not silently discard GIF/APNG/WebP animation.
  const still =
    (format === "png" && isStillPngBuffer(buffer)) ||
    format === "jpeg" ||
    (format === "webp" && !isAnimatedWebpBuffer(buffer));
  if (!still) {
    throw new Error("Managed image thumbnail is unavailable for this image format");
  }
  const maxBytes = CHAT_IMAGE_RENDITION_MAX_BYTES[width];
  const thumbnail = await createImageProcessor().encode(source, {
    // Photon supports portable fixed-quality WebP with alpha; specifying quality
    // would require an external codec. Auto-orientation remains enabled.
    format: "webp",
    resize: { maxSide: width, enlarge: false },
    maxBytes,
    // Bound work to three candidates, reducing resolution only to meet the budget.
    search: { maxSide: [width, width / 2, width / 4] },
  });
  // Rastermill returns its smallest candidate even when no candidate fits.
  if (thumbnail.data.byteLength > maxBytes) {
    throw new Error("Managed image thumbnail exceeds the preview byte limit");
  }
  return thumbnail.data;
}

const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES = 128;
const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MANAGED_IMAGE_THUMBNAIL_MAX_PENDING = 128;
const managedImageThumbnailCache = new LruCache<Buffer>(MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES, {
  maxBytes: MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES,
  sizeOf: (thumbnail) => thumbnail.byteLength,
});
const managedImageThumbnailJobs = new Map<string, Promise<Buffer>>();
const limitManagedImageThumbnails = pLimit(4);

export async function resolveManagedImageThumbnail(
  cacheKey: string,
  create: () => Promise<Buffer>,
): Promise<Buffer> {
  const cached = managedImageThumbnailCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const active = managedImageThumbnailJobs.get(cacheKey);
  if (active) {
    return await active;
  }
  if (limitManagedImageThumbnails.pendingCount >= MANAGED_IMAGE_THUMBNAIL_MAX_PENDING) {
    throw new Error("managed image thumbnail queue is full");
  }
  const pending = limitManagedImageThumbnails(create)
    .then((thumbnail) => {
      managedImageThumbnailCache.set(cacheKey, thumbnail);
      return thumbnail;
    })
    .finally(() => {
      managedImageThumbnailJobs.delete(cacheKey);
    });
  managedImageThumbnailJobs.set(cacheKey, pending);
  return await pending;
}

export async function readImageThumbnailFromFile(
  opened: Awaited<ReturnType<typeof openLocalFileSafely>>,
  maxBytes?: number,
  width: ChatImageRenditionWidth = DEFAULT_CHAT_IMAGE_RENDITION_WIDTH,
): Promise<Buffer> {
  if (maxBytes !== undefined && opened.stat.size > maxBytes) {
    throw new Error("Managed image exceeds the preview byte limit");
  }
  const { dev, ino } = opened.exactIdentity;
  const cacheKey = `${opened.realPath}\0${dev}:${ino}\0${opened.stat.ctimeMs}\0${opened.stat.mtimeMs}\0${opened.stat.size}\0${width}`;
  return await resolveManagedImageThumbnail(cacheKey, async () => {
    const source = await opened.handle.readFile();
    if (maxBytes !== undefined && source.byteLength > maxBytes) {
      throw new Error("Managed image exceeds the preview byte limit");
    }
    return await encodeImageThumbnail(source, width);
  });
}
