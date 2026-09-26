import { inspectBase64 } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
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
};

export function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
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
  const hints = [normalizeMimeType(input.mime), mimeTypeFromFilePath(input.label)];
  const mime =
    (await sniffMimeFromBase64(
      { ...facts, buffer },
      {
        additionalMimeHints: [...hints.filter((hint) => !isGenericContainerMime(hint)), ...hints],
      },
    )) ?? "application/octet-stream";
  if (!buffer && !mime.startsWith("image/")) {
    buffer = Buffer.from(input.base64, "base64");
  }
  return { sizeBytes: facts.decodedBytes, mime, buffer };
}
