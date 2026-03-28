import { estimateBase64DecodedBytes } from "../media/base64.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { saveMediaBuffer } from "../media/store.js";

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
  // bmp/tiff excluded from SUPPORTED_OFFLOAD_MIMES to avoid extension-loss
  // bug in store.ts; entries kept here for future extension support
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

// Fix #1: Moved outside loop and use a Set for O(1) lookup instead of
// rebuilding an array on every attachment iteration.
const SUPPORTED_OFFLOAD_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

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
  // NOTE: This regex is O(n) over the full string length.
  // For payloads near maxBytes (~5 MB / ~6.7 M chars) this is non-trivial.
  // A future optimization could do a sampled spot-check for very large inputs.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function ensureExtension(label: string, mime: string): string {
  if (/\.[a-zA-Z0-9]+$/.test(label)) {
    return label;
  }
  const ext = MIME_TO_EXT[mime.toLowerCase()] ?? "";
  return ext ? `${label}${ext}` : label;
}

// Fix #2: Guard against unexpected shapes from saveMediaBuffer before
// treating the result as SavedMedia, instead of blindly casting with `as`.
function assertSavedMedia(value: unknown, label: string): SavedMedia {
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as Record<string, unknown>).id === "string"
  ) {
    return value as SavedMedia;
  }
  throw new Error(`attachment ${label}: saveMediaBuffer returned unexpected shape`);
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
 * Known limitation: when a mix of large (offloaded) and small (inline) images
 * is present, offloaded images appear as text markers appended to the message
 * while inline images are in the `images` array. The agent's
 * detectAndLoadPromptImages initialises from `existingImages` first, then
 * appends prompt-detected refs, so mixed batches may be delivered to the model
 * in a different order than the original attachment list. Prompts that rely on
 * attachment order (e.g. "first image") should be aware of this. A future
 * refactor should unify all image references into a single ordered list.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000;
  const log = opts?.log;

  if (!attachments || attachments.length === 0) {
    return { message, images: [] };
  }

  const images: ChatImageContent[] = [];
  let updatedMessage = message;

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
      throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);
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

    // Fix #3: The third fallback normalizes `mime` so that a raw un-normalized
    // string (e.g. "IMAGE/JPEG" from the caller) doesn't silently bypass the
    // SUPPORTED_OFFLOAD_MIMES check below. If normalization still yields
    // nothing, fall back to the raw string as a last resort.
    const finalMime = sniffedMime ?? providedMime ?? normalizeMime(mime) ?? mime;

    let isOffloaded = false;

    // Fix #1 (continued): isSupportedForOffload now uses the module-level Set.
    const isSupportedForOffload = SUPPORTED_OFFLOAD_MIMES.has(finalMime);

    if (sizeBytes > OFFLOAD_THRESHOLD_BYTES) {
      if (!isSupportedForOffload) {
        throw new Error(
          `attachment ${label}: format ${finalMime} exceeds size limit (${sizeBytes} > ${OFFLOAD_THRESHOLD_BYTES} bytes) and is not supported by the model. Please convert to JPG, PNG, WEBP, or GIF.`,
        );
      }

      try {
        const buffer = Buffer.from(b64, "base64");
        const labelWithExt = ensureExtension(label, finalMime);

        const rawResult = await saveMediaBuffer(
          buffer,
          finalMime,
          "inbound",
          undefined,
          labelWithExt,
        );

        // Fix #2: validate shape before trusting the result.
        const savedMedia = assertSavedMedia(rawResult, label);

        // Fix #4: Use an opaque media URI instead of a physical filesystem
        // path. This decouples the Gateway from the Agent's filesystem layout
        // and is compatible with workspaceOnly sandboxes.
        // The agent side must resolve media://inbound/<id> via the media store
        // before passing the image to the model. (Follow-up: implement
        // resolveMediaUri in the agent runner.)
        const mediaRef = `media://inbound/${savedMedia.id}`;

        updatedMessage += `\n[media attached: ${mediaRef}]`;
        log?.info?.(`[Gateway] Intercepted large image payload. Saved: ${mediaRef}`);
        isOffloaded = true;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        throw new Error(
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
