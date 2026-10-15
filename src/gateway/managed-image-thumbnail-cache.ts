import pLimit from "p-limit";
import type { openLocalFileSafely } from "../infra/fs-safe.js";
import { LruCache } from "../infra/lru-cache.js";
import {
  isAnimatedWebpBuffer,
  isStillPngBuffer,
  readImageProbeFromHeader,
} from "../media/image-ops.js";
import { createImageProcessor } from "../media/image-processor.js";

// Chat previews occupy up to 400 CSS pixels on displays with up to 3× density.
const MANAGED_IMAGE_THUMBNAIL_MAX_SIDE = 1200;
const MANAGED_IMAGE_THUMBNAIL_MAX_BYTES = 512 * 1024;

export async function encodeImageThumbnail(source: Uint8Array): Promise<Buffer> {
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
  const thumbnail = await createImageProcessor().encode(source, {
    format: "png",
    resize: { maxSide: MANAGED_IMAGE_THUMBNAIL_MAX_SIDE, enlarge: false },
    compressionLevel: 8,
    maxBytes: MANAGED_IMAGE_THUMBNAIL_MAX_BYTES,
    // Keep lossless 3× detail when possible, then 2×/1× for dense images.
    search: { maxSide: [MANAGED_IMAGE_THUMBNAIL_MAX_SIDE, 800, 400], compressionLevel: [8] },
  });
  // Rastermill returns its smallest candidate even when no candidate fits.
  if (thumbnail.data.byteLength > MANAGED_IMAGE_THUMBNAIL_MAX_BYTES) {
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
): Promise<Buffer> {
  if (maxBytes !== undefined && opened.stat.size > maxBytes) {
    throw new Error("Managed image exceeds the preview byte limit");
  }
  const { dev, ino } = opened.exactIdentity;
  const cacheKey = `${opened.realPath}\0${dev}:${ino}\0${opened.stat.ctimeMs}\0${opened.stat.mtimeMs}\0${opened.stat.size}`;
  return await resolveManagedImageThumbnail(cacheKey, async () => {
    const source = await opened.handle.readFile();
    if (maxBytes !== undefined && source.byteLength > maxBytes) {
      throw new Error("Managed image exceeds the preview byte limit");
    }
    return await encodeImageThumbnail(source);
  });
}
