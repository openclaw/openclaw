import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GeneratedImageAsset } from "./asset-types.js";
import { generatedImageAssetFromBase64 } from "./image-assets.js";
import type { ImageGenerationRequest } from "./provider-types.js";

const DEFAULT_OUTPUT_MIME = "image/png";
const GOOGLE_IMAGE_MALFORMED_RESPONSE = "Google image generation response malformed";

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(size);
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);

  const [widthRaw, heightRaw] = normalized.split("x");
  const width = parseStrictPositiveInteger(widthRaw);
  const height = parseStrictPositiveInteger(heightRaw);
  if (width === undefined || height === undefined) {
    return undefined;
  }
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

function googleResponseParts(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const candidates = payload.candidates;
  if (candidates === undefined || candidates === null) {
    return [];
  }
  if (!Array.isArray(candidates)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }

  const parts: unknown[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const content = candidate.content;
    if (content === undefined || content === null) {
      continue;
    }
    if (!isRecord(content)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const candidateParts = content.parts;
    if (candidateParts === undefined || candidateParts === null) {
      continue;
    }
    if (!Array.isArray(candidateParts)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    parts.push(...candidateParts);
  }
  return parts;
}

function googleInlineDataFromPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const inline = part.inlineData ?? part.inline_data;
  if (inline === undefined || inline === null) {
    return undefined;
  }
  if (!isRecord(inline)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  return inline;
}

/** Native GenerateContent image body shared by direct and catalog-scoped consumers. */
export function buildGoogleImageGenerationBody(
  req: Pick<
    ImageGenerationRequest,
    "prompt" | "inputImages" | "size" | "aspectRatio" | "resolution"
  >,
) {
  const imageConfig = mapSizeToImageConfig(req.size);
  const inputParts = (req.inputImages ?? []).map((image) => ({
    inlineData: {
      mimeType: image.mimeType,
      data: image.buffer.toString("base64"),
    },
  }));
  const resolvedImageConfig = {
    ...imageConfig,
    ...(req.aspectRatio?.trim() ? { aspectRatio: req.aspectRatio.trim() } : {}),
    ...(req.resolution ? { imageSize: req.resolution } : {}),
  };

  return {
    contents: [
      {
        role: "user",
        parts: [...inputParts, { text: req.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(Object.keys(resolvedImageConfig).length > 0 ? { imageConfig: resolvedImageConfig } : {}),
    },
  };
}

/** Decode the native inline image result; the caller owns HTTP completion and route qualification. */
export function parseGoogleImageGenerationResponse(
  payload: unknown,
  normalizeBase64: (value: string) => string | undefined = (value) => value,
): GeneratedImageAsset[] {
  const images: GeneratedImageAsset[] = [];
  for (const part of googleResponseParts(payload)) {
    const inline = googleInlineDataFromPart(part);
    if (!inline) {
      continue;
    }
    const data = normalizeOptionalString(inline.data);
    if (!data) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const standardData = normalizeBase64(data);
    if (!standardData) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const image = generatedImageAssetFromBase64({
      base64: standardData,
      index: images.length,
      mimeType:
        normalizeOptionalString(inline.mimeType) ??
        normalizeOptionalString(inline.mime_type) ??
        DEFAULT_OUTPUT_MIME,
    });
    if (!image) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    images.push(image);
  }

  if (images.length === 0) {
    throw new Error("Google image generation response missing image data");
  }

  return images;
}
