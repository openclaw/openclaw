// Control UI helper converts picked avatar images into compact data URLs.
import { AVATAR_MAX_BYTES } from "../../../../src/shared/avatar-limits.js";

/** Uploaded avatars also mirror into prompt-injected IDENTITY.md. Keep their
    encoded form below the per-file bootstrap limit with room for identity text. */
const AVATAR_TARGET_SIZE = 96;
const AVATAR_EDITOR_MAX_DATA_URL_CHARS = 16_000;
/** PNG fallback edges, largest first. Browsers without canvas WebP encoding
    (e.g. WebKit) emit PNG, which is several times larger for detailed art. */
const AVATAR_PNG_FALLBACK_SIZES = [AVATAR_TARGET_SIZE, 64, 48] as const;

export type AvatarDataUrlResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "unusable" | "too-detailed" };

const UNUSABLE: AvatarDataUrlResult = { ok: false, reason: "unusable" };
const TOO_DETAILED: AvatarDataUrlResult = { ok: false, reason: "too-detailed" };

function boundAvatarDataUrl(value: string | null): AvatarDataUrlResult {
  if (!value) {
    return UNUSABLE;
  }
  return value.length <= AVATAR_EDITOR_MAX_DATA_URL_CHARS
    ? { ok: true, dataUrl: value }
    : TOO_DETAILED;
}

function readFileAsDataUrl(file: File): Promise<AvatarDataUrlResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(boundAvatarDataUrl(typeof reader.result === "string" ? reader.result : null)),
    );
    reader.addEventListener("error", () => resolve(UNUSABLE));
    reader.readAsDataURL(file);
  });
}

function fitsEditorBudget(value: string, mime: "image/jpeg" | "image/png"): boolean {
  return value.startsWith(`data:${mime}`) && value.length <= AVATAR_EDITOR_MAX_DATA_URL_CHARS;
}

function isOpaque(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) {
      return false;
    }
  }
  return true;
}

/** Convert a picked image file into a data URL bounded for identity storage.
    Distinguishes files that cannot be used at all from images whose resized
    encoding still exceeds the identity budget. */
export async function fileToAvatarDataUrl(file: File): Promise<AvatarDataUrlResult> {
  if (!file.type.startsWith("image/") || file.size > AVATAR_MAX_BYTES) {
    return UNUSABLE;
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        return await readFileAsDataUrl(file);
      }
      const draw = (edge: number) => {
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      };
      draw(AVATAR_TARGET_SIZE);
      // toDataURL silently falls back to PNG when WebP is unsupported.
      const webp = canvas.toDataURL("image/webp", 0.8);
      if (webp.startsWith("data:image/webp")) {
        return boundAvatarDataUrl(webp);
      }
      // Without WebP, JPEG keeps opaque images compact. JPEG would flatten
      // transparency, so transparent images step down in size as PNG instead.
      if (isOpaque(context, canvas.width, canvas.height)) {
        const jpeg = canvas.toDataURL("image/jpeg", 0.85);
        if (fitsEditorBudget(jpeg, "image/jpeg")) {
          return { ok: true, dataUrl: jpeg };
        }
      }
      for (const edge of AVATAR_PNG_FALLBACK_SIZES) {
        draw(edge);
        const png = canvas.toDataURL("image/png");
        if (fitsEditorBudget(png, "image/png")) {
          return { ok: true, dataUrl: png };
        }
      }
      return TOO_DETAILED;
    } finally {
      bitmap.close();
    }
  } catch {
    // Non-rasterizable images (e.g. SVG without intrinsic size) pass through
    // unscaled; the size gate above still bounds the persisted payload.
    return readFileAsDataUrl(file);
  }
}
