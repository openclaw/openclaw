import { createImageProcessor } from "./image-ops.js";
import { normalizeMimeType } from "./input-files.js";

const ANTHROPIC_INLINE_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
const ANTHROPIC_INLINE_IMAGE_MIME_SET = new Set<string>(ANTHROPIC_INLINE_IMAGE_MIMES);
const ANTHROPIC_INLINE_IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;

function maxBinaryBytesForBase64Budget(maxBase64Bytes: number): number {
  return Math.floor(maxBase64Bytes / 4) * 3;
}

export type AnthropicInlineImageMimeType = (typeof ANTHROPIC_INLINE_IMAGE_MIMES)[number];

export function isAnthropicInlineImageMimeType(
  mimeType: string | undefined,
): mimeType is AnthropicInlineImageMimeType {
  return mimeType !== undefined && ANTHROPIC_INLINE_IMAGE_MIME_SET.has(mimeType);
}

export async function normalizeImageForAnthropic(
  image: Readonly<{ data: string; mimeType: string }>,
): Promise<{ data: string; mimeType: AnthropicInlineImageMimeType }> {
  const normalizedMime = normalizeMimeType(image.mimeType);
  if (isAnthropicInlineImageMimeType(normalizedMime)) {
    return { data: image.data, mimeType: normalizedMime };
  }

  const output = await createImageProcessor().encode(Buffer.from(image.data, "base64"), {
    format: "auto",
    limits: {
      maxWidth: 2000,
      maxHeight: 2000,
    },
    maxBytes: maxBinaryBytesForBase64Budget(ANTHROPIC_INLINE_IMAGE_MAX_BYTES),
    opaque: { format: "jpeg", quality: 85 },
    transparent: { format: "png" },
    search: {
      quality: [85, 70, 55, 40],
      compressionLevel: [6, 9],
    },
  });
  const outputMime = normalizeMimeType(output.mimeType);
  if (!isAnthropicInlineImageMimeType(outputMime)) {
    throw new Error(
      `Unsupported Anthropic inline image MIME after normalization: ${output.mimeType}`,
    );
  }
  return {
    data: output.data.toString("base64"),
    mimeType: outputMime,
  };
}
