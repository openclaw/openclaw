import { estimateBase64DecodedBytes } from "../media/base64.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { deleteMediaBuffer, saveMediaBuffer } from "../media/store.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
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
  path?: string;
};

const OFFLOAD_THRESHOLD_BYTES = 2_000_000;

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  // bmp/tiff excluded from SUPPORTED_OFFLOAD_MIMES to avoid extension-loss
  // bug in store.ts; entries kept here for future extension support
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

// Moved outside the loop and uses a Set for O(1) lookup instead of
// rebuilding an array on every attachment iteration.
const SUPPORTED_OFFLOAD_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

/**
 * Raised when the Gateway cannot persist an attachment to the media store.
 *
 * This is distinct from ordinary input-validation errors so that Gateway
 * handlers can map it to a server-side 5xx status rather than a client 4xx.
 *
 * Example causes: ENOSPC, EPERM, unexpected saveMediaBuffer return shape.
 */
export class MediaOffloadError extends Error {
  readonly cause: unknown;
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
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  // A full O(n) regex scan is safe because the regex has no overlapping
  // quantifiers and fails linearly without catastrophic backtracking.
  // This prevents adversarial payloads padded with megabytes of whitespace
  // from bypassing length thresholds.
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Confirms that the decoded buffer produced by Buffer.from(b64, 'base64')
 * matches the pre-decode size estimate.
 *
 * Node's Buffer.from silently drops invalid base64 characters rather than
 * throwing. A material size discrepancy means the source string contained
 * embedded garbage that was silently stripped, which would produce a
 * corrupted file on disk. ±3 bytes of slack accounts for base64 padding
 * rounding.
 */
function verifyDecodedSize(buffer: Buffer, estimatedBytes: number, label: string): void {
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
  const ext = MIME_TO_EXT[mime.toLowerCase()] ?? "";
  return ext ? `${label}${ext}` : label;
}

/**
 * Type guard for the return value of saveMediaBuffer.
 *
 * Also validates that the returned ID:
 * - is a non-empty string
 * - contains no path separators (/ or \) or null bytes
 *
 * This provides defence-in-depth before the ID is embedded in a
 * media://inbound/<id> URI and later resolved by resolveMediaBufferPath
 * (which applies its own guards). Catching a bad shape here produces a
 * cleaner error message than a cryptic failure deeper in the stack.
 */
function assertSavedMedia(value: unknown, label: string): SavedMedia {
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as Record<string, unknown>).id === "string"
  ) {
    const id = (value as Record<string, unknown>).id as string;
    if (id.length === 0) {
      throw new Error(`attachment ${label}: saveMediaBuffer returned an empty media ID`);
    }
    if (id.includes("/") || id.includes("\\") || id.includes("\0")) {
      throw new Error(
        `attachment ${label}: saveMediaBuffer returned an unsafe media ID ` +
          `(contains path separator or null byte)`,
      );
    }
    return value as SavedMedia;
  }
  throw new Error(`attachment ${label}: saveMediaBuffer returned an unexpected shape`);
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
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text and an array of image content blocks
 * compatible with Claude API's image format.
 *
 * Attachments whose decoded size exceeds OFFLOAD_THRESHOLD_BYTES are saved to
 * disk via saveMediaBuffer and replaced with an opaque `media://inbound/<id>`
 * URI appended to the message. Downstream agents must resolve this URI via the
 * media store before forwarding to the model.
 *
 * Pass `supportsImages: false` for text-only model runs. In that case all
 * attachments are dropped cleanly and no media:// markers are injected into
 * the prompt, preventing internal path references from leaking into model input.
 *
 * On any parse failure after one or more files have already been offloaded,
 * this function performs a best-effort cleanup of those files before rethrowing
 * so that malformed requests do not accumulate orphaned files on disk.
 *
 * Known limitation: when a mix of large (offloaded) and small (inline) images
 * is present, offloaded images appear as text markers appended to the message
 * while inline images are in the `images` array. The agent's
 * detectAndLoadPromptImages initialises from `existingImages` first, then
 * appends prompt-detected refs, so mixed batches may be delivered to the model
 * in a different order than the original attachment list. Prompts that rely on
 * attachment order (e.g. "first image") should be aware of this. A future
 * refactor should unify all image references into a single ordered list.
 *
 * @throws {MediaOffloadError} When a filesystem error prevents saving an
 * attachment to the media store. Callers should map this to a server-side
 * 5xx status rather than a client 4xx.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog; supportsImages?: boolean },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000;
  const log = opts?.log;

  if (!attachments || attachments.length === 0) {
    return { message, images: [] };
  }

  // For text-only models, attachments cannot be used regardless of size.
  // Drop them cleanly instead of saving files and injecting media:// markers
  // that would never be resolved, which would leak internal path references
  // into the model's prompt.
  if (opts?.supportsImages === false) {
    if (attachments.length > 0) {
      log?.warn(
        `parseMessageWithAttachments: ${attachments.length} attachment(s) dropped — model does not support images`,
      );
    }
    return { message, images: [] };
  }

  const images: ChatImageContent[] = [];
  let updatedMessage = message;

  // Track IDs of files saved during this request so we can clean them up
  // if a later attachment fails validation and the entire parse is aborted.
  // Without this, repeated malformed multi-attachment requests can accumulate
  // orphaned files on disk ahead of the periodic TTL sweep.
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

      if (!isValidBase64(b64)) {
        throw new Error(`attachment ${label}: invalid base64 content`);
      }

      const sizeBytes = estimateBase64DecodedBytes(b64);
      if (sizeBytes <= 0) {
        log?.warn(`attachment ${label}: estimated size is zero, dropping`);
        continue;
      }

      if (sizeBytes > maxBytes) {
        throw new Error(
          `attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`,
        );
      }

      const providedMime = normalizeMime(mime);
      const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));

      if (sniffedMime && !isImageMime(sniffedMime)) {
        log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
        continue;
      }
      if (!sniffedMime && !isImageMime(providedMime)) {
        log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
        continue;
      }
      if (sniffedMime && providedMime && sniffedMime !== providedMime) {
        log?.warn(
          `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
        );
      }

      // The third fallback normalises `mime` so that a raw un-normalised string
      // (e.g. "IMAGE/JPEG" from the caller) does not silently bypass the
      // SUPPORTED_OFFLOAD_MIMES check below. If normalisation still yields
      // nothing, fall back to the raw string as a last resort.
      const finalMime = sniffedMime ?? providedMime ?? normalizeMime(mime) ?? mime;

      let isOffloaded = false;

      const isSupportedForOffload = SUPPORTED_OFFLOAD_MIMES.has(finalMime);

      if (sizeBytes > OFFLOAD_THRESHOLD_BYTES) {
        if (!isSupportedForOffload) {
          // The attachment is above the offload threshold but its format cannot
          // be offloaded (no guaranteed extension mapping in store.ts).
          // Note: sizeBytes is between OFFLOAD_THRESHOLD_BYTES and maxBytes, so
          // saying "exceeds size limit" would be misleading — the image IS within
          // the declared limit but cannot safely be offloaded in this format.
          throw new Error(
            `attachment ${label}: format ${finalMime} is too large to pass inline ` +
              `(${sizeBytes} > ${OFFLOAD_THRESHOLD_BYTES} bytes) and cannot be offloaded. ` +
              `Please convert to JPEG, PNG, WEBP, GIF, HEIC, or HEIF.`,
          );
        }

        try {
          const buffer = Buffer.from(b64, "base64");

          // Post-decode size validation for large payloads.
          // Provides defense-in-depth against silent truncation by Buffer.from
          // if any malformed characters somehow bypassed prior validation.
          verifyDecodedSize(buffer, sizeBytes, label);

          const labelWithExt = ensureExtension(label, finalMime);

          const rawResult = await saveMediaBuffer(
            buffer,
            finalMime,
            "inbound",
            maxBytes,
            labelWithExt,
          );

          // Validate shape and ID safety before trusting the result.
          const savedMedia = assertSavedMedia(rawResult, label);

          // Track this ID for cleanup if a later attachment fails.
          savedMediaIds.push(savedMedia.id);

          // Use an opaque media URI instead of a physical filesystem path.
          // This decouples the Gateway from the Agent's filesystem layout
          // and is compatible with workspaceOnly sandboxes.
          // The agent resolves media://inbound/<id> via resolveMediaBufferPath
          // in store.ts before passing the image to the model.
          const mediaRef = `media://inbound/${savedMedia.id}`;

          updatedMessage += `\n[media attached: ${mediaRef}]`;
          log?.info?.(`[Gateway] Intercepted large image payload. Saved: ${mediaRef}`);
          isOffloaded = true;
        } catch (err) {
          // Distinguish operational storage failures from input-validation errors
          // so that Gateway handlers can map them to the correct HTTP status:
          // catch MediaOffloadError → 5xx, catch Error → 4xx.
          const errorMessage = err instanceof Error ? err.message : String(err);
          throw new MediaOffloadError(
            `[Gateway Error] Failed to save intercepted media to disk: ${errorMessage}`,
            { cause: err },
          );
        }
      }

      if (isOffloaded) {
        continue;
      }

      images.push({ type: "image", data: b64, mimeType: finalMime });
    }
  } catch (err) {
    // Best-effort cleanup: delete any files that were successfully saved
    // earlier in this request before re-throwing. This prevents malformed
    // multi-attachment requests from accumulating orphaned files on disk
    // ahead of the periodic TTL sweep.
    if (savedMediaIds.length > 0) {
      await Promise.allSettled(savedMediaIds.map((id) => deleteMediaBuffer(id, "inbound")));
    }
    throw err;
  }

  return {
    message: updatedMessage !== message ? updatedMessage.trimEnd() : message,
    images,
  };
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
