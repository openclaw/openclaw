import { sliceMimeSniffBuffer } from "@openclaw/media-core/mime";
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

export type ManagedImageThumbnail = { data: Buffer; transformed: boolean };

/** Artifact previews conservatively optimize only known-still browser formats. */
export async function isKnownStillImageBuffer(source: Buffer): Promise<boolean> {
  const sourceType = await import("file-type")
    .then(({ fileTypeFromBuffer }) => fileTypeFromBuffer(sliceMimeSniffBuffer(source)))
    .catch(() => undefined);
  // Rastermill has no frame count, and bounded MIME sniffing can miss APNG.
  // Preserve containers whose still-image status we cannot establish.
  return (
    (sourceType?.mime === "image/png" && isStillPngBuffer(source)) ||
    sourceType?.mime === "image/jpeg" ||
    (sourceType?.mime === "image/webp" && !isAnimatedWebpBuffer(source))
  );
}

/** Keep browser animation containers intact; other inputs retain the processor's conversion contract. */
export function shouldPreserveImageAnimation(source: Buffer): boolean {
  const format = readImageProbeFromHeader(source)?.format;
  return (
    format === "gif" ||
    (format === "png" && !isStillPngBuffer(source)) ||
    (format === "webp" && isAnimatedWebpBuffer(source))
  );
}

export async function encodeImageThumbnail(source: Uint8Array): Promise<ManagedImageThumbnail> {
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (shouldPreserveImageAnimation(buffer)) {
    return { data: buffer, transformed: false };
  }
  const { data } = await createImageProcessor().encode(source, {
    format: "png",
    resize: { maxSide: MANAGED_IMAGE_THUMBNAIL_MAX_SIDE, enlarge: false },
    compressionLevel: 8,
  });
  return { data, transformed: true };
}

export async function readManagedImageThumbnailFromFile(
  opened: Awaited<ReturnType<typeof openLocalFileSafely>>,
  maxBytes?: number,
): Promise<ManagedImageThumbnail> {
  if (maxBytes !== undefined && opened.stat.size > maxBytes) {
    throw new Error("Managed image exceeds the preview byte limit");
  }
  const cacheKey = `${opened.realPath}\0${opened.stat.mtimeMs}\0${opened.stat.size}`;
  return await resolveManagedImageThumbnail(cacheKey, async () => {
    const source = await opened.handle.readFile();
    if (maxBytes !== undefined && source.byteLength > maxBytes) {
      throw new Error("Managed image exceeds the preview byte limit");
    }
    return await encodeImageThumbnail(source);
  });
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
