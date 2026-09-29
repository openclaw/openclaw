import { normalizeMimeType } from "@openclaw/media-core/mime";
import { fileTypeFromBuffer } from "file-type";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createImageProcessor, isAnimatedWebpBuffer } from "../media/image-ops.js";
import { isAvatarImageMimeType, isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { GatewayAvatarImageSource } from "./assistant-avatar-cache.js";
import {
  createHttpImageRepresentation,
  type HttpImageRepresentation,
} from "./http-image-response.js";

const AVATAR_THUMBNAIL_SIDE = 128;
const thumbnailCache = new Map<string, HttpImageRepresentation>();
const pendingThumbnails = new Map<string, Promise<HttpImageRepresentation>>();

async function createAvatarThumbnail(
  source: GatewayAvatarImageSource,
): Promise<HttpImageRepresentation> {
  let body: Buffer;
  let contentType: string;
  if ("file" in source) {
    if (!source.file.body) {
      throw new Error("Avatar bytes were not prepared");
    }
    body = source.file.body;
    contentType = resolveAvatarMime(source.file.path);
  } else {
    if (!isRenderableAvatarImageDataUrl(source.dataUrl)) {
      throw new Error("Unsupported avatar data URL");
    }
    // The validated data: scheme uses native byte decoding without network I/O.
    // Preserve charset parameters for unchanged SVG/XML representations.
    const response = await fetch(source.dataUrl);
    contentType = response.headers.get("content-type") ?? "";
    body = Buffer.from(await response.arrayBuffer());
    if (body.length > AVATAR_MAX_BYTES) {
      throw new Error("Avatar data URL exceeds size limit");
    }
  }
  const mime = normalizeMimeType(contentType);
  if (!mime || !isAvatarImageMimeType(mime)) {
    throw new Error("Unsupported avatar image type");
  }
  // Preserve animation/vector bytes; Rastermill's PNG output contains only one frame.
  if (["image/png", "image/jpeg", "image/webp"].includes(mime)) {
    const detectedMime = (await fileTypeFromBuffer(body))?.mime;
    if (detectedMime === "image/apng" || isAnimatedWebpBuffer(body)) {
      return createHttpImageRepresentation(body, contentType);
    }
    body = (
      await createImageProcessor().encode(body, {
        format: "png",
        resize: { maxSide: AVATAR_THUMBNAIL_SIDE, enlarge: false },
      })
    ).data;
    contentType = "image/png";
  }
  return createHttpImageRepresentation(body, contentType);
}

export async function readGatewayAvatarThumbnail(
  source: GatewayAvatarImageSource,
): Promise<HttpImageRepresentation> {
  const { revision } = source;
  const cached = thumbnailCache.get(revision);
  if (cached) {
    thumbnailCache.delete(revision);
    thumbnailCache.set(revision, cached);
    return cached;
  }
  return getOrCreatePromise(
    pendingThumbnails,
    revision,
    async () => {
      const image = await createAvatarThumbnail(source);
      thumbnailCache.set(revision, image);
      // Pending jobs retain their own custody until settlement, independently of the LRU.
      pruneMapToMaxSize(thumbnailCache, 4);
      return image;
    },
    { evictOnSettled: true },
  );
}
