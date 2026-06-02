import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { extensionForMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { deleteMediaBuffer, saveMediaBuffer } from "../media/store.js";

/**
 * Raw attachment shape accepted by Gateway chat entrypoints.
 * content must be base64 when present; MIME and filename are hints that are
 * validated against sniffed bytes before model/runtime delivery.
 */
export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

/**
 * Inline image block passed to model runtimes that accept native image inputs.
 * Large images and all non-image files use media refs instead.
 */
export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

/**
 * Disk-backed attachment reference surfaced to agent runtimes as media:// URLs.
 * The path is retained for host tools while message text carries only mediaRef.
 */
export type OffloadedRef = {
  mediaRef: string;
  id: string;
  path: string;
  mimeType: string;
  label: string;
  sizeBytes: number;
};

type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
};

type AttachmentLog = {
  info?: (message: string) => void;
  warn: (message: string) => void;
};

type NormalizedAttachment = {
  label: string;
  mime: string;
  base64: string;
};

type SavedMedia = {
  id: string;
  path: string;
};

const OFFLOAD_THRESHOLD_BYTES = 2_000_000;
const TEXT_ONLY_OFFLOAD_LIMIT = 10;

/** Default per-attachment upload ceiling when agent config has no media limit. */
export const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;

/**
 * Resolves the per-agent inbound attachment ceiling in bytes.
 * Invalid or absent config falls back to the product default rather than
 * disabling the upload guard.
 */
export function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.mediaMaxMb;
  const mb =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

type UnsupportedAttachmentReason =
  | "empty-payload"
  | "text-only-image"
  | "unsupported-non-image"
  | "non-image-too-large-for-sandbox";

/**
 * Signals caller-actionable attachment rejection, such as unsupported file
 * kind or image input on a text-only entrypoint.
 */
export class UnsupportedAttachmentError extends Error {
  readonly reason: UnsupportedAttachmentReason;
  constructor(reason: UnsupportedAttachmentReason, message: string) {
    super(message);
    this.name = "UnsupportedAttachmentError";
    this.reason = reason;
  }
}

/**
 * Wraps failures after validation when an accepted attachment cannot be saved
 * into the inbound media store.
 */
export class MediaOffloadError extends Error {
  override readonly cause: unknown;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaOffloadError";
    this.cause = options?.cause;
  }
}

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = normalizeOptionalLowercaseString(mime.split(";")[0]);
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
}

function shouldIgnoreImageMimeHint(params: { sniffedMime?: string; hintedMime?: string }): boolean {
  return isGenericContainerMime(params.sniffedMime) && isImageMime(params.hintedMime);
}

function isSpecificMime(mime?: string): boolean {
  return Boolean(mime && !isGenericContainerMime(mime));
}

function resolveAttachmentMime(params: {
  sniffedMime?: string;
  providedMime?: string;
  labelMime?: string;
}): string {
  // Generic containers are useful fallback signals, but they must not let a
  // caller-provided image hint turn a zip/octet payload into inline image input.
  const trustedProvidedMime = shouldIgnoreImageMimeHint({
    sniffedMime: params.sniffedMime,
    hintedMime: params.providedMime,
  })
    ? undefined
    : params.providedMime;
  const trustedLabelMime = shouldIgnoreImageMimeHint({
    sniffedMime: params.sniffedMime,
    hintedMime: params.labelMime,
  })
    ? undefined
    : params.labelMime;
  return (
    (isSpecificMime(params.sniffedMime) && params.sniffedMime) ||
    (isSpecificMime(trustedProvidedMime) && trustedProvidedMime) ||
    (isSpecificMime(trustedLabelMime) && trustedLabelMime) ||
    params.sniffedMime ||
    trustedProvidedMime ||
    trustedLabelMime ||
    "application/octet-stream"
  );
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function verifyDecodedSize(buffer: Buffer, estimatedBytes: number, label: string): void {
  // Buffer.from silently skips some invalid base64 characters. Compare the
  // decoded byte count against the preflight estimate before the payload is
  // saved or sent to model input.
  if (Math.abs(buffer.byteLength - estimatedBytes) > 3) {
    throw new Error(
      `attachment ${label}: base64 contains invalid characters ` +
        `(expected ~${estimatedBytes} bytes decoded, got ${buffer.byteLength})`,
    );
  }
}

function ensureExtension(label: string, mime: string): string {
  if (/\.[a-zA-Z0-9]+$/.test(label)) {
    return label;
  }
  const ext = extensionForMime(mime) ?? "";
  return ext ? `${label}${ext}` : label;
}

function assertSavedMedia(value: unknown, label: string): SavedMedia {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof (value as Record<string, unknown>).id !== "string"
  ) {
    throw new Error(`attachment ${label}: saveMediaBuffer returned an unexpected shape`);
  }
  const id = (value as Record<string, unknown>).id as string;
  if (id.length === 0) {
    throw new Error(`attachment ${label}: saveMediaBuffer returned an empty media ID`);
  }
  // saveMediaBuffer owns the storage root. Reject path-like IDs so media://
  // references cannot escape the inbound media namespace if the store changes.
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(
      `attachment ${label}: saveMediaBuffer returned an unsafe media ID ` +
        `(contains path separator or null byte)`,
    );
  }
  const path = (value as Record<string, unknown>).path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`attachment ${label}: saveMediaBuffer returned no on-disk path`);
  }
  return { id, path };
}

function normalizeAttachment(
  att: ChatAttachment,
  idx: number,
  opts: { stripDataUrlPrefix: boolean; requireImageMime: boolean },
): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  if (opts.requireImageMime && !mime.startsWith("image/")) {
    throw new Error(`attachment ${label}: only image/* supported`);
  }

  let base64 = content.trim();
  if (opts.stripDataUrlPrefix) {
    // Chat clients commonly send data URLs. Strip only the wrapper here so the
    // same base64 validator covers raw and data-URL attachment payloads.
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
  }
  return { label, mime, base64 };
}

function validateAttachmentBase64OrThrow(
  normalized: NormalizedAttachment,
  opts: { maxBytes: number },
): number {
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
  if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    throw new Error(
      `attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`,
    );
  }
  return sizeBytes;
}

/**
 * Converts client attachments into native image blocks and/or inbound media
 * references while preserving image order for prompt construction.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    supportsImages?: boolean;
    supportsInlineImages?: boolean;
    acceptNonImage?: boolean;
  },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;
  const log = opts?.log;
  const shouldForceImageOffload = opts?.supportsImages === false;
  const supportsInlineImages = opts?.supportsInlineImages !== false;
  const acceptNonImage = opts?.acceptNonImage !== false;

  if (!attachments || attachments.length === 0) {
    return { message, images: [], imageOrder: [], offloadedRefs: [] };
  }

  const images: ChatImageContent[] = [];
  const imageOrder: PromptImageOrderEntry[] = [];
  const offloadedRefs: OffloadedRef[] = [];
  let updatedMessage = message;
  let textOnlyImageOffloadCount = 0;
  const savedMediaIds: string[] = [];

  try {
    for (const [idx, att] of attachments.entries()) {
      if (!att) {
        continue;
      }

      const normalized = normalizeAttachment(att, idx, {
        stripDataUrlPrefix: true,
        requireImageMime: false,
      });

      const { base64: b64, label, mime } = normalized;

      if (b64.length === 0) {
        throw new UnsupportedAttachmentError("empty-payload", `attachment ${label}: empty payload`);
      }
      if (!isValidBase64(b64)) {
        throw new Error(`attachment ${label}: invalid base64 content`);
      }

      const sizeBytes = estimateBase64DecodedBytes(b64);
      if (sizeBytes > maxBytes) {
        throw new Error(
          `attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`,
        );
      }

      const providedMime = normalizeMime(mime);
      const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
      const labelMime = normalizeMime(mimeTypeFromFilePath(label));

      // Prefer specific MIME signals over generic container types. OOXML
      // documents (docx/xlsx/pptx) sniff as application/zip; without this
      // priority the agent would receive a `.zip` instead of the specific
      // Office document the caller declared.
      const finalMime = resolveAttachmentMime({ sniffedMime, providedMime, labelMime });

      if (
        sniffedMime &&
        providedMime &&
        !isGenericContainerMime(providedMime) &&
        sniffedMime !== providedMime
      ) {
        const usedSource =
          finalMime === sniffedMime
            ? "sniffed"
            : finalMime === providedMime
              ? "provided"
              : "label-derived";
        log?.warn(
          `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using ${usedSource}`,
        );
      }

      const isImage = isImageMime(finalMime);
      if (isImage && !supportsInlineImages && !shouldForceImageOffload) {
        throw new UnsupportedAttachmentError(
          "text-only-image",
          `attachment ${label}: active model does not accept image inputs`,
        );
      }
      if (!isImage && !acceptNonImage) {
        throw new UnsupportedAttachmentError(
          "unsupported-non-image",
          `attachment ${label}: non-image attachments (${finalMime}) are not supported on this entrypoint`,
        );
      }
      // Agent-side hydration (loadImageFromRef via optimizeAndClampImage / GIF
      // direct compare) caps at MAX_IMAGE_BYTES. Accepting images above that
      // would offload a file the runner later drops to null — a successful
      // response with a silently missing image. Reject here so the client
      // sees an explicit 4xx. Non-image attachments keep the full maxBytes
      // ceiling because their host path (ctx.MediaPaths → Read/Bash) doesn't
      // load into the model.
      if (isImage && sizeBytes > MAX_IMAGE_BYTES) {
        throw new Error(
          `attachment ${label}: image exceeds size limit (${sizeBytes} > ${MAX_IMAGE_BYTES} bytes)`,
        );
      }

      if (
        shouldForceImageOffload &&
        isImage &&
        textOnlyImageOffloadCount >= TEXT_ONLY_OFFLOAD_LIMIT
      ) {
        log?.warn(
          `attachment ${label}: dropping image because text-only offload limit ` +
            `${TEXT_ONLY_OFFLOAD_LIMIT} was reached`,
        );
        updatedMessage += "\n[image attachment omitted: text-only attachment limit reached]";
        continue;
      }

      const shouldOffload =
        shouldForceImageOffload || !isImage || sizeBytes > OFFLOAD_THRESHOLD_BYTES;

      if (!shouldOffload) {
        // Preserve small images as native model inputs. imageOrder keeps their
        // relative position next to later offloaded image refs for prompt order.
        images.push({ type: "image", data: b64, mimeType: finalMime });
        imageOrder.push("inline");
        continue;
      }

      const buffer = Buffer.from(b64, "base64");
      verifyDecodedSize(buffer, sizeBytes, label);

      let savedMedia: SavedMedia;
      try {
        const labelWithExt = ensureExtension(label, finalMime);
        const rawResult = await saveMediaBuffer(
          buffer,
          finalMime,
          "inbound",
          maxBytes,
          labelWithExt,
        );
        savedMedia = assertSavedMedia(rawResult, label);
      } catch (err) {
        throw new MediaOffloadError(
          `[Gateway Error] Failed to save intercepted media to disk: ${formatErrorMessage(err)}`,
          { cause: err },
        );
      }

      savedMediaIds.push(savedMedia.id);

      const mediaRef = `media://inbound/${savedMedia.id}`;
      if (isImage) {
        // Text-only image offload still needs a prompt-visible placeholder;
        // non-image files are exposed through offloadedRefs/tool context only.
        updatedMessage += `\n[media attached: ${mediaRef}]`;
      }
      log?.info?.(
        shouldForceImageOffload && isImage
          ? `[Gateway] Offloaded image for text-only model. Saved: ${mediaRef}`
          : `[Gateway] Offloaded attachment (${finalMime}). Saved: ${mediaRef}`,
      );

      offloadedRefs.push({
        mediaRef,
        id: savedMedia.id,
        path: savedMedia.path,
        mimeType: finalMime,
        label,
        sizeBytes,
      });
      if (isImage) {
        imageOrder.push("offloaded");
        if (shouldForceImageOffload) {
          textOnlyImageOffloadCount++;
        }
      }
    }
  } catch (err) {
    if (savedMediaIds.length > 0) {
      // Treat parsing as all-or-nothing. A later invalid attachment must not
      // leave earlier offloaded media reachable without a successful message.
      await Promise.allSettled(savedMediaIds.map((id) => deleteMediaBuffer(id, "inbound")));
    }
    throw err;
  }

  return {
    message: updatedMessage !== message ? updatedMessage.trimEnd() : message,
    images,
    imageOrder,
    offloadedRefs,
  };
}

/**
 * Classifies an attachment before full parsing using the same MIME precedence
 * as parseMessageWithAttachments.
 */
export async function resolveChatAttachmentLooksLikeImage(
  attachment: ChatAttachment,
  index = 0,
): Promise<boolean> {
  const normalized = normalizeAttachment(attachment, index, {
    stripDataUrlPrefix: true,
    requireImageMime: false,
  });
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const providedMime = normalizeMime(normalized.mime);
  const sniffedMime = normalizeMime(await sniffMimeFromBase64(normalized.base64));
  const labelMime = normalizeMime(mimeTypeFromFilePath(normalized.label));
  return isImageMime(resolveAttachmentMime({ sniffedMime, providedMime, labelMime }));
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000;

  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }

    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: false,
      requireImageMime: true,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });

    const { base64, label, mime } = normalized;
    const safeLabel = label.replace(/\s+/g, "_");
    blocks.push(`![${safeLabel}](data:${mime};base64,${base64})`);
  }

  if (blocks.length === 0) {
    return message;
  }

  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
