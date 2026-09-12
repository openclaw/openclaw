import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import {
  detectMime,
  FILE_TYPE_SNIFF_MAX_BYTES,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { convertImageToJpeg, convertImageToPng } from "./image-ops.js";

const ANTHROPIC_SUPPORTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
// Match OpenClaw's decoded inbound-image hard cap before any copy or native decode.
const ANTHROPIC_INLINE_IMAGE_DECODE_SAFETY_BYTES = 10 * 1024 * 1024;
const ANTHROPIC_MIME_PREFIX_BASE64_CHARS = 4 * Math.ceil(FILE_TYPE_SNIFF_MAX_BYTES / 3);

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
  const canonicalData = canonicalizeBase64(block.data);
  const data = canonicalData ?? block.data.trim();
  // Only canonical input can be truncated without changing permissive base64 decoding.
  const sniffData = canonicalData?.slice(0, ANTHROPIC_MIME_PREFIX_BASE64_CHARS) ?? data;
  const buffer = Buffer.from(sniffData, "base64");
  const declaredMime = normalizeMimeType(block.mimeType);
  const detectedMime = normalizeMimeType(await detectMime({ buffer }));
  if (isAnthropicSupportedImageMime(detectedMime)) {
    return { data, mimeType: detectedMime };
  }
  if (!detectedMime && isAnthropicSupportedImageMime(declaredMime)) {
    return { data, mimeType: declaredMime };
  }

  const convertToPng = detectedMime === "image/bmp";
  const conversionBuffer = sniffData.length === data.length ? buffer : Buffer.from(data, "base64");
  const normalizedBuffer = convertToPng
    ? await convertImageToPng(conversionBuffer)
    : await convertImageToJpeg(conversionBuffer);
  if (normalizedBuffer.byteLength > ANTHROPIC_INLINE_IMAGE_DECODE_SAFETY_BYTES) {
    throw new Error("Normalized Anthropic inline image exceeds the 10 MB decoded safety limit.");
  }
  return {
    data: normalizedBuffer.toString("base64"),
    mimeType: convertToPng ? "image/png" : "image/jpeg",
  };
}

export async function normalizeAnthropicInlineContentBlocks(
  content: readonly AnthropicInlineBlock[],
): Promise<NormalizedAnthropicInlineBlock[]> {
  for (const block of content) {
    if (block.type !== "image") {
      continue;
    }
    const bytes = estimateBase64DecodedBytes(block.data);
    if (bytes > ANTHROPIC_INLINE_IMAGE_DECODE_SAFETY_BYTES) {
      throw new Error("Anthropic inline image exceeds the 10 MB decoded safety limit.");
    }
  }

  const normalized: NormalizedAnthropicInlineBlock[] = [];
  for (const block of content) {
    if (block.type !== "image") {
      normalized.push(block);
      continue;
    }
    normalized.push({
      ...block,
      ...(await normalizeAnthropicInlineImage(block)),
    });
  }
  return normalized;
}
