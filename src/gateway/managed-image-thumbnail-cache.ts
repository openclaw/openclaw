import pLimit from "p-limit";
import { LruCache } from "../infra/lru-cache.js";
import { createImageProcessor } from "../media/image-processor.js";

// Chat previews occupy up to 400 CSS pixels on displays with up to 3× density.
const MANAGED_IMAGE_THUMBNAIL_MAX_SIDE = 1200;

export async function encodeImageThumbnail(source: Uint8Array): Promise<Buffer> {
  return (
    await createImageProcessor().encode(source, {
      format: "png",
      resize: { maxSide: MANAGED_IMAGE_THUMBNAIL_MAX_SIDE, enlarge: false },
      compressionLevel: 8,
    })
  ).data;
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
