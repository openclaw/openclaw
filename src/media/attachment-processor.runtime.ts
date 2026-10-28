import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import { inspectBase64 } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import { readImageMetadataFromHeader } from "./image-ops.js";
import { sniffMimeFromBase64 } from "./sniff-mime-from-base64.js";

export const ATTACHMENT_OFFLOAD_THRESHOLD_BYTES = 2_000_000;

export type AttachmentInput = {
  base64: string;
  label: string;
  mime: string;
  imageStorage?: "inline";
};

export type PreparedAttachment = {
  sizeBytes: number;
  mime: string;
  buffer?: Uint8Array<ArrayBuffer>;
  width?: number;
  height?: number;
};

export function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
}

function readAttachmentImageMetadata(base64: string) {
  // Fixed headers are selected from bytes, never MIME hints.
  if (base64.startsWith("iVBORw0KGgoAAAAN")) {
    return readImageMetadataFromHeader(Buffer.from(base64.slice(0, 32), "base64"));
  }
  if (base64.startsWith("R0lGODdh") || base64.startsWith("R0lGODlh")) {
    return readImageMetadataFromHeader(Buffer.from(base64.slice(0, 16), "base64"));
  }
  const head = Buffer.from(base64.slice(0, 40), "base64");
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return readImageMetadataFromHeader(head);
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    // EXIF may follow SOF. Reach the first scan before accepting dimensions;
    // Rastermill remains the owner of dimensions and EXIF interpretation.
    for (let bytes = 4096; bytes <= 256 * 1024; bytes *= 4) {
      const chars = Math.ceil(bytes / 3) * 4;
      const prefix = Buffer.from(base64.slice(0, chars), "base64");
      if (chars >= base64.length) {
        return readImageMetadataFromHeader(prefix);
      }
      while (offset + 4 < prefix.length && prefix[offset] === 0xff) {
        const marker = prefix[offset + 1];
        if (marker === 0xff) {
          offset++;
          continue;
        }
        if (marker === 0xda || marker === 0xd9) {
          const metadata = readImageMetadataFromHeader(prefix);
          if (metadata) {
            return metadata;
          }
          break;
        }
        const length = prefix.readUInt16BE(offset + 2);
        if (length < 2 || offset + 2 + length > prefix.length) {
          break;
        }
        offset += 2 + length;
      }
    }
  }
  // Preserve permissive parsing of malformed or unusually long headers and other formats.
  return readImageMetadataFromHeader(Buffer.from(base64, "base64"));
}

export async function prepareAttachment(input: AttachmentInput): Promise<PreparedAttachment> {
  const facts = inspectBase64(input.base64, "attachment");
  if (!facts) {
    throw new Error(`attachment ${input.label}: invalid base64 content`);
  }
  // Reuse large upload bytes for sniffing; above the image cap, classify before decoding.
  let buffer =
    input.imageStorage !== "inline" &&
    facts.decodedBytes > ATTACHMENT_OFFLOAD_THRESHOLD_BYTES &&
    facts.decodedBytes <= MAX_IMAGE_BYTES
      ? Buffer.from(input.base64, "base64")
      : undefined;
  const inputMime = normalizeMimeType(input.mime);
  const hints = [inputMime, mimeTypeFromFilePath(input.label)];
  let mime =
    (await sniffMimeFromBase64(
      { ...facts, buffer },
      {
        additionalMimeHints: [...hints.filter((hint) => !isGenericContainerMime(hint)), ...hints],
      },
    )) ?? "application/octet-stream";
  if (!buffer && !mime.startsWith("image/")) {
    buffer = Buffer.from(input.base64, "base64");
  }
  if (
    buffer &&
    mime.startsWith("text/") &&
    (!inputMime || inputMime === "application/octet-stream")
  ) {
    const classification = await classifyAttachmentBytes({ buffer, name: input.label });
    if (classification.class === "text" && classification.charset) {
      // Inferred MIME becomes a persisted content type; retain its byte-derived encoding.
      mime = `${mime}; charset=${classification.charset}`;
    }
  }
  const dimensions =
    mime.startsWith("image/") && facts.decodedBytes <= MAX_IMAGE_BYTES
      ? buffer
        ? readImageMetadataFromHeader(buffer)
        : readAttachmentImageMetadata(input.base64)
      : null;
  return { sizeBytes: facts.decodedBytes, mime, buffer, ...dimensions };
}
