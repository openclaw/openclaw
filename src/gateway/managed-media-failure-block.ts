import type { ReplyMediaFailureCode } from "../auto-reply/reply-payload.js";
import type { ManagedMediaKind } from "./managed-image-attachments.media-kind.js";

/** Display card for one reply attachment that could not be delivered. */
export function buildManagedMediaFailureBlock(params: {
  code: ReplyMediaFailureCode;
  kind: ManagedMediaKind | "media";
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  maxBytes?: number;
}): Record<string, unknown> {
  const sizeFacts =
    params.code === "file-too-large"
      ? {
          ...(isByteCount(params.sizeBytes) ? { sizeBytes: params.sizeBytes } : {}),
          ...(isByteCount(params.maxBytes) ? { maxBytes: params.maxBytes } : {}),
        }
      : {};
  return {
    type: "attachment_error",
    attachment: {
      code: params.code,
      kind: params.kind === "media" ? "document" : params.kind,
      label: params.label,
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      ...sizeFacts,
    },
  };
}

function isByteCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
