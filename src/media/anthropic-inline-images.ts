/**
 * Anthropic Messages accepts only jpeg/png/gif/webp for inline base64 images.
 * Normalize declared MIME (and bytes when needed) before payload construction so
 * HEIC/TIFF and mislabeled supported bytes do not 400 the whole turn.
 */
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { detectMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { convertImageToJpeg } from "./image-ops.js";

const ANTHROPIC_SUPPORTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type AnthropicSupportedImageMime = (typeof ANTHROPIC_SUPPORTED_IMAGE_MIMES)[number];

type AnthropicInlineTextBlock = { type: "text"; text: string };
type AnthropicInlineImageBlock = { type: "image"; data: string; mimeType: string };
type AnthropicInlineBlock = AnthropicInlineTextBlock | AnthropicInlineImageBlock;
type NormalizedAnthropicInlineImageBlock = Omit<AnthropicInlineImageBlock, "mimeType"> & {
  mimeType: AnthropicSupportedImageMime;
};
type NormalizedAnthropicInlineBlock =
  | AnthropicInlineTextBlock
  | NormalizedAnthropicInlineImageBlock;

const ANTHROPIC_SUPPORTED_IMAGE_MIME_SET = new Set<string>(ANTHROPIC_SUPPORTED_IMAGE_MIMES);

function isAnthropicSupportedImageMime(
  value: string | undefined,
): value is AnthropicSupportedImageMime {
  return typeof value === "string" && ANTHROPIC_SUPPORTED_IMAGE_MIME_SET.has(value);
}

async function normalizeAnthropicInlineImage(block: AnthropicInlineImageBlock): Promise<{
  data: string;
  mimeType: AnthropicSupportedImageMime;
}> {
  const canonicalData = canonicalizeBase64(block.data) ?? block.data.trim();
  const declaredMime = normalizeMimeType(block.mimeType);
  // Supported declaration: keep bytes as-is (no re-encode tax on common paths).
  if (isAnthropicSupportedImageMime(declaredMime)) {
    return { data: canonicalData, mimeType: declaredMime };
  }

  const buffer = Buffer.from(canonicalData, "base64");
  // Mislabeled but already-supported bytes (e.g. JPEG snuck in as image/heic).
  const detectedMime = normalizeMimeType(await detectMime({ buffer, headerMime: block.mimeType }));
  if (isAnthropicSupportedImageMime(detectedMime)) {
    return { data: canonicalData, mimeType: detectedMime };
  }

  // Real HEIC/TIFF/etc.: re-encode to JPEG so media_type matches the bytes.
  const normalizedBuffer = await convertImageToJpeg(buffer);
  return {
    data: normalizedBuffer.toString("base64"),
    mimeType: "image/jpeg",
  };
}

/** Normalize text/image content blocks for Anthropic Messages inline image rules. */
export async function normalizeAnthropicInlineContentBlocks(
  content: readonly AnthropicInlineBlock[],
): Promise<NormalizedAnthropicInlineBlock[]> {
  return await Promise.all(
    content.map(async (block) => {
      if (block.type !== "image") {
        return block;
      }
      return {
        ...block,
        ...(await normalizeAnthropicInlineImage(block)),
      };
    }),
  );
}
