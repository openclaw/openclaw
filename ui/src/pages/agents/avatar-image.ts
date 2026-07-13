// Control UI helper converts picked avatar images into compact data URLs.
import { AVATAR_MAX_BYTES } from "../../../../src/shared/avatar-limits.js";

/** Downscale bound keeps identity avatars small: the value is persisted into
    openclaw.json and IDENTITY.md as a data URL, so raw camera images must not
    pass through at full size. */
const AVATAR_TARGET_SIZE = 256;

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(typeof reader.result === "string" ? reader.result : null),
    );
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

/** Convert a picked image file into a data URL bounded for identity storage.
    Returns null when the file is not an image or cannot be encoded. */
export async function fileToAvatarDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/") || file.size > AVATAR_MAX_BYTES) {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AVATAR_TARGET_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return readFileAsDataUrl(file);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // toDataURL silently falls back to PNG when WebP is unsupported.
    const encoded = canvas.toDataURL("image/webp", 0.85);
    return encoded.startsWith("data:image/webp") ? encoded : canvas.toDataURL("image/png");
  } catch {
    // Non-rasterizable images (e.g. SVG without intrinsic size) pass through
    // unscaled; the size gate above still bounds the persisted payload.
    return readFileAsDataUrl(file);
  }
}
