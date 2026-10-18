import { normalizeMimeType } from "@openclaw/media-core/mime";
import { fileTypeFromBuffer } from "file-type";
import { createImageProcessor, isAnimatedWebpBuffer } from "../media/image-ops.js";
import { isAvatarImageMimeType, isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import type { GatewayAvatarImageSource } from "./assistant-avatar-cache.js";
import {
  createHttpImageRepresentation,
  type HttpImageRepresentation,
} from "./http-image-response.js";

const AVATAR_THUMBNAIL_SIDE = 128;
// The admitted source owns both pending and completed work until its revision is replaced.
const thumbnails = new WeakMap<GatewayAvatarImageSource, Promise<HttpImageRepresentation>>();
const notificationIcons = new WeakMap<GatewayAvatarImageSource, Promise<string | undefined>>();

async function createAvatarThumbnail(
  source: GatewayAvatarImageSource,
  maxSide = AVATAR_THUMBNAIL_SIDE,
  signal?: AbortSignal,
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
        resize: { maxSide, enlarge: false },
        signal,
      })
    ).data;
    contentType = "image/png";
  }
  return createHttpImageRepresentation(body, contentType);
}

export async function readGatewayAvatarThumbnail(
  source: GatewayAvatarImageSource,
): Promise<HttpImageRepresentation> {
  let pending = thumbnails.get(source);
  if (!pending) {
    pending = createAvatarThumbnail(source).catch((error: unknown) => {
      thumbnails.delete(source);
      throw error;
    });
    thumbnails.set(source, pending);
  }
  return pending;
}

/** Inline push icons work while the browser is offline from Gateway image authentication. */
export function readGatewayAvatarNotificationIcon(
  source: GatewayAvatarImageSource,
): Promise<string | undefined> {
  let pending = notificationIcons.get(source);
  if (!pending) {
    pending = (async () => {
      const signal = AbortSignal.timeout(5_000);
      for (const maxSide of [32, 24]) {
        const image = await createAvatarThumbnail(source, maxSide, signal);
        if (image.contentType !== "image/png") {
          return undefined;
        }
        const icon = `data:image/png;base64,${image.body.toString("base64")}`;
        if (icon.length <= 2_400) {
          return icon;
        }
      }
      return undefined;
    })().catch(() => {
      notificationIcons.delete(source);
      return undefined;
    });
    notificationIcons.set(source, pending);
  }
  return pending;
}
