import pLimit from "p-limit";

const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES = 128;
const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MANAGED_IMAGE_THUMBNAIL_MAX_PENDING = 128;
const managedImageThumbnailCache = new Map<string, Buffer>();
const managedImageThumbnailJobs = new Map<string, Promise<Buffer>>();
const limitManagedImageThumbnails = pLimit(4);
let managedImageThumbnailCacheBytes = 0;

function readManagedImageThumbnail(cacheKey: string): Buffer | undefined {
  const thumbnail = managedImageThumbnailCache.get(cacheKey);
  if (!thumbnail) {
    return undefined;
  }
  managedImageThumbnailCache.delete(cacheKey);
  managedImageThumbnailCache.set(cacheKey, thumbnail);
  return thumbnail;
}

function cacheManagedImageThumbnail(cacheKey: string, thumbnail: Buffer): void {
  const previous = managedImageThumbnailCache.get(cacheKey);
  if (previous) {
    managedImageThumbnailCache.delete(cacheKey);
    managedImageThumbnailCacheBytes -= previous.byteLength;
  }
  managedImageThumbnailCache.set(cacheKey, thumbnail);
  managedImageThumbnailCacheBytes += thumbnail.byteLength;
  while (
    managedImageThumbnailCache.size > MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES ||
    managedImageThumbnailCacheBytes > MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES
  ) {
    const oldest = managedImageThumbnailCache.entries().next().value;
    if (!oldest) {
      break;
    }
    managedImageThumbnailCache.delete(oldest[0]);
    managedImageThumbnailCacheBytes -= oldest[1].byteLength;
  }
}

export async function resolveManagedImageThumbnail(
  cacheKey: string,
  create: () => Promise<Buffer>,
): Promise<Buffer> {
  const cached = readManagedImageThumbnail(cacheKey);
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
      cacheManagedImageThumbnail(cacheKey, thumbnail);
      return thumbnail;
    })
    .finally(() => {
      managedImageThumbnailJobs.delete(cacheKey);
    });
  managedImageThumbnailJobs.set(cacheKey, pending);
  return await pending;
}
