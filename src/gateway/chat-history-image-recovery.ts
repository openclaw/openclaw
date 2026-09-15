import { createHash } from "node:crypto";
import { sanitizeInlineImageBase64 } from "@openclaw/media-core/inline-image-data-url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const CHAT_HISTORY_IMAGE_ARTIFACT_PREFIX = "artifact_history_image_";
const CHAT_HISTORY_IMAGE_SESSION_PLACEHOLDER = "__history__";

function readBase64Payload(value: unknown, dataUrlOnly = false): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  let payload = trimmed;
  if (/^data:/iu.test(trimmed)) {
    const comma = trimmed.indexOf(",");
    const header = comma >= 0 ? trimmed.slice(0, comma) : "";
    if (!/^data:image\//iu.test(header) || !/;base64(?:;|$)/iu.test(header)) {
      return undefined;
    }
    payload = trimmed.slice(comma + 1);
  } else if (dataUrlOnly) {
    return undefined;
  }
  return payload;
}

function mediaUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return readBase64Payload(value, true);
  }
  return readBase64Payload(asOptionalRecord(value)?.url, true);
}

function imagePayload(block: Record<string, unknown>): string | undefined {
  const source = asOptionalRecord(block.source);
  return (
    readBase64Payload(block.data) ??
    readBase64Payload(block.blob) ??
    readBase64Payload(source?.data) ??
    readBase64Payload(source?.blob) ??
    mediaUrlValue(block.image_url) ??
    readBase64Payload(block.url, true) ??
    readBase64Payload(block.openUrl, true) ??
    readBase64Payload(source?.url, true)
  );
}

export type ChatHistoryImageRecovery = {
  artifactId: string;
  mimeType: string;
};

/** Stable opaque handle for verified image bytes that stay private in the transcript. */
export function resolveChatHistoryImageRecovery(
  block: unknown,
): ChatHistoryImageRecovery | undefined {
  const entry = asOptionalRecord(block);
  if (!entry || normalizeOptionalString(entry.type)?.toLowerCase() !== "image") {
    return undefined;
  }
  const payload = imagePayload(entry);
  if (!payload) {
    return undefined;
  }
  const source = asOptionalRecord(entry.source);
  const declaredMimeType =
    normalizeOptionalString(entry.mimeType) ??
    normalizeOptionalString(entry.media_type) ??
    normalizeOptionalString(source?.mimeType) ??
    normalizeOptionalString(source?.media_type) ??
    "image/unknown";
  const sanitized = sanitizeInlineImageBase64({
    mimeType: declaredMimeType,
    base64: payload,
  });
  if (!sanitized) {
    return undefined;
  }
  const hash = createHash("sha256")
    .update(`${sanitized.mimeType}\0${sanitized.base64}`)
    .digest("base64url")
    .slice(0, 24);
  return {
    artifactId: `${CHAT_HISTORY_IMAGE_ARTIFACT_PREFIX}${hash}`,
    mimeType: sanitized.mimeType,
  };
}

export function buildChatHistoryImagePlaceholderUrl(artifactId: string): string {
  return `/api/chat/media/outgoing/${CHAT_HISTORY_IMAGE_SESSION_PLACEHOLDER}/${encodeURIComponent(artifactId)}/full`;
}
