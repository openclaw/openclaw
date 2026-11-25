import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ImageContent } from "../agents/command/types.js";
import { extractImageContentFromSource, type InputImageSource } from "../media/input-files.js";
import type { resolveOpenAiChatCompletionsLimits } from "./openai-compatible-input-limits.js";

function resolveImageUrlPart(part: unknown): string | undefined {
  const imageUrl = asOptionalObjectRecord(part)?.image_url;
  return normalizeOptionalString(
    typeof imageUrl === "string" ? imageUrl : asOptionalObjectRecord(imageUrl)?.url,
  );
}

type ExtractedImageUrls = { kind: "valid"; urls: string[] } | { kind: "invalid" };

export function extractImageUrls(content: unknown): ExtractedImageUrls {
  const urls: string[] = [];
  if (!Array.isArray(content)) {
    return { kind: "valid", urls };
  }
  for (const part of content) {
    if (asOptionalObjectRecord(part)?.type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (!url) {
      return { kind: "invalid" };
    }
    urls.push(url);
  }
  return { kind: "valid", urls };
}

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

export async function resolveImagesForRequest(
  activeTurnContext: { imageUrls: ExtractedImageUrls },
  limits: ReturnType<typeof resolveOpenAiChatCompletionsLimits>,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<ImageContent[]> {
  signal.throwIfAborted();
  if (activeTurnContext.imageUrls.kind === "invalid") {
    throw new Error("image_url part is missing a valid URL");
  }
  const urls = activeTurnContext.imageUrls.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    assertCurrent();
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images, signal);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}
