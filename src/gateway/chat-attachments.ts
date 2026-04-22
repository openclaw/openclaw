import { formatErrorMessage } from "../infra/errors.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { deleteMediaBuffer, resolveMediaBufferPath, saveMediaBuffer } from "../media/store.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

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

/**
 * Metadata for an attachment that was offloaded to the media store.
 *
 * Included in ParsedMessageWithImages.offloadedRefs so that callers can
 * persist structured media metadata for transcripts. Without this, consumers
 * that derive MediaPath/MediaPaths from the `images` array (e.g.
 * persistChatSendImages and buildChatSendTranscriptMessage in chat.ts) would
 * silently omit all large attachments that were offloaded to disk.
 */
export type OffloadedRef = {
  /** Opaque media URI injected into the message, e.g. "media://inbound/<id>" */
  mediaRef: string;
  /** The raw media ID from SavedMedia.id, usable with resolveMediaBufferPath */
  id: string;
  /** Absolute filesystem path returned by saveMediaBuffer — used for transcript MediaPath */
  path: string;
  /** MIME type of the offloaded attachment */
  mimeType: string;
  /** The label / filename of the original attachment */
  label: string;
};

export type ParsedMessageWithImages = {
  message: string;
  /** Small attachments (≤ OFFLOAD_THRESHOLD_BYTES) passed inline to the model */
  images: ChatImageContent[];
  /** Original accepted attachment order after inline/offloaded split. */
  imageOrder: PromptImageOrderEntry[];
  /**
   * Large attachments (> OFFLOAD_THRESHOLD_BYTES) that were offloaded to the
   * media store. Each entry corresponds to a `[media attached: media://inbound/<id>]`
   * marker appended to `message`.
   *
   * Callers MUST persist this list separately for transcript media metadata.
   * It is intentionally separate from `images` because downstream model calls
   * do not receive these as inline image blocks.
   *
   * In text-only mode (supportsImages=false), ALL image attachments are
   * offloaded regardless of size so that a configured imageModel can describe
   * them. The `images` array will be empty in that case.
   */
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

// Module-level Set for O(1) lookup — not rebuilt on every attachment iteration.
//
// heic/heif are included only if store.ts's extensionForMime maps them to an
// extension. If it does not (same extension-loss risk as bmp/tiff), remove
// them from this set.
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
 * Distinct from ordinary input-validation errors so that Gateway handlers can
 * map it to a server-side 5xx status rather than a client 4xx.
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
  const cleaned = normalizeOptionalLowercaseString(mime.split(";")[0]);
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  // A full O(n) regex scan is safe: no overlapping quantifiers, fails linearly.
  // Prevents adversarial payloads padded with megabytes of whitespace from
  // bypassing length thresholds.
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Confirms that the decoded buffer produced by Buffer.from(b64, 'base64')
 * matches the pre-decode size estimate.
 *
 * Node's Buffer.from silently drops invalid base64 characters rather than
 * throwing. A material size discrepancy means the source string contained
 * embedded garbage that was silently stripped, which would produce a corrupted
 * file on disk. ±3 bytes of slack accounts for base64 padding rounding.
 *
 * IMPORTANT: this is an input-validation check (4xx client error).
 * It MUST be called OUTSIDE the MediaOffloadError try/catch so that
 * corrupt-input errors are not misclassified as 5xx server errors.
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
  const ext = MIME_TO_EXT[normalizeLowercaseStringOrEmpty(mime)] ?? "";
  return ext ? `${label}${ext}` : label;
}

/**
 * Type guard for the return value of saveMediaBuffer.
 *
 * Also validates that the returned ID:
 * - is a non-empty string
 * - contains no path separators (/ or \) or null bytes
 *
 * Catching a bad shape here produces a cleaner error than a cryptic failure
 * deeper in the stack, and is treated as a 5xx infrastructure error.
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
 * Returns the message text, inline image blocks, and offloaded media refs.
 *
 * ## Offload behaviour
 * Attachments whose decoded size exceeds OFFLOAD_THRESHOLD_BYTES are saved to
 * disk via saveMediaBuffer and replaced with an opaque `media://inbound/<id>`
 * URI appended to the message. The agent resolves these URIs via
 * resolveMediaBufferPath before passing them to the model.
 *
 * ## Transcript metadata
 * Callers MUST use `result.offloadedRefs` to persist structured media metadata
 * for transcripts. These refs are intentionally excluded from `result.images`
 * because they are not passed inline to the model.
 *
 * ## Text-only model runs
 * Pass `supportsImages: false` for text-only model runs. Attachments are still
 * offloaded to the media store with `media://` markers injected into the prompt
 * so that downstream image description pipelines can resolve and describe them
 * using a configured `imageModel`. The `images` array will be empty in this case;
 * only `offloadedRefs` and `imageOrder` entries (all marked "offloaded") are produced.
 *
 * ## Cleanup on failure
 * On any parse failure after files have already been offloaded, best-effort
 * cleanup is performed before rethrowing so that malformed requests do not
 * accumulate orphaned files on disk ahead of the periodic TTL sweep.
 *
 * ## Known ordering limitation
 * In mixed large/small batches, the model receives images in a different order
 * than the original attachment list because detectAndLoadPromptImages
 * initialises from existingImages first, then appends prompt-detected refs.
 * A future refactor should unify all image references into a single ordered list.
 *
 * @throws {MediaOffloadError} Infrastructure failure saving to media store → 5xx.
 * @throws {Error} Input validation failure → 4xx.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog; supportsImages?: boolean },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000;
  const log = opts?.log;

  if (!attachments || attachments.length === 0) {
    return { message, images: [], imageOrder: [], offloadedRefs: [] };
  }

  // For text-only models, offload all attachments to the media store but
  // do NOT pass them as inline image blocks. The media:// markers are
  // injected so that downstream image description pipelines (e.g.
  // describeOffloadedImagesForTextOnlyModel) can resolve and describe them
  // using a configured imageModel. Previously, attachments were dropped
  // entirely, which meant the agent never saw them at all.
  const textOnlyMode = opts?.supportsImages === false;

  // In text-only mode, cap the number of attachments that get offloaded to
  // disk. Without this cap, a single request with many attachments causes
  // unbounded media-store writes and I/O amplification before the downstream
  // fanout limit (MAX_DESCRIBE_FANOUT in describeOffloadedImagesForTextOnlyModel)
  // kicks in. Attachments beyond this budget are neutralized as text-only
  // markers without persisting to disk.
  const MAX_TEXT_ONLY_OFFLOAD = 10;
  let textOnlyOffloadCount = 0;

  const images: ChatImageContent[] = [];
  const imageOrder: PromptImageOrderEntry[] = [];
  const offloadedRefs: OffloadedRef[] = [];
  let updatedMessage = message;

  // Track IDs of files saved during this request for cleanup if a later
  // attachment fails validation and the entire parse is aborted.
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

      // Third fallback normalises `mime` so a raw un-normalised string (e.g.
      // "IMAGE/JPEG") does not silently bypass the SUPPORTED_OFFLOAD_MIMES check.
      const finalMime = sniffedMime ?? providedMime ?? normalizeMime(mime) ?? mime;

      // In text-only mode, always offload to the media store so that
      // downstream image description pipelines can resolve and describe the
      // images using a configured imageModel. Inline image blocks are never
      // produced because the primary model cannot process them.
      const forceOffload = textOnlyMode;

      // In text-only mode, cap offloads before writing to disk. Excess
      // attachments are neutralized as text markers without persisting
      // to the media store, preventing unbounded I/O from large batches.
      if (forceOffload && textOnlyOffloadCount >= MAX_TEXT_ONLY_OFFLOAD) {
        log?.warn(
          `attachment ${label}: text-only offload cap (${MAX_TEXT_ONLY_OFFLOAD}) reached, neutralizing without disk write`,
        );
        updatedMessage += `\n[image attached but not offloaded: text-only attachment cap reached]`;
        imageOrder.push("offloaded");
        continue;
      }

      let isOffloaded = false;

      if (forceOffload || sizeBytes > OFFLOAD_THRESHOLD_BYTES) {
        const isSupportedForOffload = SUPPORTED_OFFLOAD_MIMES.has(finalMime);

        if (!isSupportedForOffload) {
          if (forceOffload) {
            // Text-only mode: can't inline and can't offload this format.
            // Drop gracefully rather than crashing the session.
            log?.warn(
              `attachment ${label}: unsupported offload format ${finalMime} for text-only model, dropping`,
            );
            continue;
          }
          // Passing this inline would reintroduce the OOM risk this PR prevents.
          throw new Error(
            `attachment ${label}: format ${finalMime} is too large to pass inline ` +
              `(${sizeBytes} > ${OFFLOAD_THRESHOLD_BYTES} bytes) and cannot be offloaded. ` +
              `Please convert to JPEG, PNG, WEBP, GIF, HEIC, or HEIF.`,
          );
        }

        // Decode and run input-validation BEFORE the MediaOffloadError try/catch.
        // verifyDecodedSize is a 4xx client error and must not be wrapped as a
        // 5xx MediaOffloadError.
        const buffer = Buffer.from(b64, "base64");
        verifyDecodedSize(buffer, sizeBytes, label);

        // Only the storage operation is wrapped so callers can distinguish
        // infrastructure failures (5xx) from input errors (4xx).
        try {
          const labelWithExt = ensureExtension(label, finalMime);

          const rawResult = await saveMediaBuffer(
            buffer,
            finalMime,
            "inbound",
            maxBytes,
            labelWithExt,
          );

          const savedMedia = assertSavedMedia(rawResult, label);

          // Track for cleanup if a subsequent attachment fails.
          savedMediaIds.push(savedMedia.id);

          // Opaque URI — compatible with workspaceOnly sandboxes and decouples
          // the Gateway from the agent's filesystem layout.
          const mediaRef = `media://inbound/${savedMedia.id}`;

          updatedMessage += `\n[media attached: ${mediaRef}]`;
          log?.info?.(
            `[Gateway] ${forceOffload ? "Text-only model offload" : "Intercepted large image payload"}. Saved: ${mediaRef}`,
          );

          // Record for transcript metadata — separate from `images` because
          // these are not passed inline to the model.
          offloadedRefs.push({
            mediaRef,
            id: savedMedia.id,
            path: savedMedia.path ?? "",
            mimeType: finalMime,
            label,
          });
          imageOrder.push("offloaded");

          isOffloaded = true;
          textOnlyOffloadCount++;
        } catch (err) {
          const errorMessage = formatErrorMessage(err);
          throw new MediaOffloadError(
            `[Gateway Error] Failed to save intercepted media to disk: ${errorMessage}`,
            { cause: err },
          );
        }
      }

      if (isOffloaded) {
        continue;
      }

      // In text-only mode, inline images are never produced. This branch
      // is only reached when textOnlyMode is false and size <= threshold.
      images.push({ type: "image", data: b64, mimeType: finalMime });
      imageOrder.push("inline");
    }
  } catch (err) {
    // Best-effort cleanup before rethrowing.
    if (savedMediaIds.length > 0) {
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

/**
 * Describes offloaded images using a vision-capable imageModel so that
 * text-only primary models can still process image attachments.
 *
 * When the primary model does not support images (supportsImages=false),
 * `parseMessageWithAttachments` offloads all images to the media store and
 * injects `[media attached: media://inbound/<id>]` markers into the message.
 * This function resolves those markers, describes the images using the
 * configured imageModel, and replaces the markers with human-readable
 * descriptions so the text-only model can reason about the image content.
 *
 * If no imageModel is configured or description fails for an image, the
 * original `media://` marker is preserved in the message (graceful fallback).
 *
 * @param parsed Result from `parseMessageWithAttachments` with offloadedRefs
 * @param cfg OpenClawConfig for resolving imageModel
 * @param agentDir Optional agent directory for provider resolution
 * @returns Updated message with media:// markers replaced by descriptions
 */
export async function describeOffloadedImagesForTextOnlyModel(params: {
  parsed: ParsedMessageWithImages;
  cfg: import("../config/types.js").OpenClawConfig;
  agentDir?: string;
  log?: AttachmentLog;
}): Promise<ParsedMessageWithImages> {
  const { parsed, cfg, agentDir, log } = params;

  if (parsed.offloadedRefs.length === 0) {
    return parsed;
  }

  // Dynamically import the media-understanding description functions
  // through the *.runtime.ts boundary convention (see CLAUDE.md).
  let resolveAutoImageModel:
    | typeof import("./media-understanding-describe.runtime.js").resolveAutoImageModel
    | undefined;
  let describeImageFileWithModel:
    | typeof import("./media-understanding-describe.runtime.js").describeImageFileWithModel
    | undefined;
  try {
    const runtime = await import("./media-understanding-describe.runtime.js");
    resolveAutoImageModel = runtime.resolveAutoImageModel;
    describeImageFileWithModel = runtime.describeImageFileWithModel;
  } catch {
    log?.warn("describeOffloadedImages: failed to import media-understanding modules");
    // Neutralize markers so the runner doesn't try to parse them as image refs
    let neutralMessage = parsed.message;
    for (const ref of parsed.offloadedRefs) {
      const marker = `[media attached: ${ref.mediaRef}]`;
      neutralMessage = neutralMessage.replace(
        marker,
        "[image attached but could not be described: media-understanding import failed]",
      );
    }
    return { ...parsed, message: neutralMessage };
  }

  // Resolve the imageModel from config (e.g. agents.defaults.imageModel).
  // resolveAutoImageModel checks activeModel then falls back to key-order,
  // but it does NOT check agents.defaults.imageModel (that logic lives in
  // resolveAutoEntries which is used by the `image` tool path, not here).
  // So we resolve the configured imageModel first and pass it as activeModel
  // so multi-provider setups route descriptions to the correct provider.
  let activeModelFromConfig: { provider: string; model: string } | undefined;
  if (typeof cfg.agents?.defaults?.imageModel === "string" && cfg.agents.defaults.imageModel.includes("/")) {
    const slashIdx = cfg.agents.defaults.imageModel.indexOf("/");
    activeModelFromConfig = {
      provider: cfg.agents.defaults.imageModel.slice(0, slashIdx),
      model: cfg.agents.defaults.imageModel.slice(slashIdx + 1),
    };
  } else if (cfg.agents?.defaults?.imageModel && typeof cfg.agents.defaults.imageModel === "object") {
    const primary = cfg.agents.defaults.imageModel.primary;
    if (primary && primary.includes("/")) {
      const slashIdx = primary.indexOf("/");
      activeModelFromConfig = {
        provider: primary.slice(0, slashIdx),
        model: primary.slice(slashIdx + 1),
      };
    }
  }

  // Guard against resolveAutoImageModel throwing (e.g. provider misconfiguration)
  // so that a config error doesn't crash the entire message pipeline.
  let imageModel: Awaited<ReturnType<typeof resolveAutoImageModel>> | undefined;
  try {
    imageModel = await resolveAutoImageModel({ cfg, agentDir, activeModel: activeModelFromConfig });
  } catch (err) {
    log?.warn(
      `describeOffloadedImages: resolveAutoImageModel failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Neutralize all media:// markers so the runner doesn't try to parse them
    let neutralMessage = parsed.message;
    for (const ref of parsed.offloadedRefs) {
      const marker = `[media attached: ${ref.mediaRef}]`;
      neutralMessage = neutralMessage.replace(
        marker,
        "[image attached but could not be described: imageModel resolution failed]",
      );
    }
    return { ...parsed, message: neutralMessage };
  }
  if (!imageModel?.model) {
    log?.warn(
      `describeOffloadedImages: no imageModel configured, ${parsed.offloadedRefs.length} image(s) cannot be described`,
    );
    // Neutralize all media:// markers so the downstream runner doesn't try
    // to parse them as image refs (which would fail for text-only models).
    let neutralMessage = parsed.message;
    for (const ref of parsed.offloadedRefs) {
      const marker = `[media attached: ${ref.mediaRef}]`;
      neutralMessage = neutralMessage.replace(
        marker,
        "[image attached but could not be described: no imageModel configured]",
      );
    }
    return { ...parsed, message: neutralMessage };
  }

  let updatedMessage = parsed.message;

  // Cap per-request description fanout to avoid unbounded cost/latency.
  // Gateway RPC schemas accept unbounded attachments arrays; without a cap,
  // one request could trigger many sequential paid image-description calls.
  const MAX_DESCRIBE_FANOUT = 5;
  const refsToDescribe = parsed.offloadedRefs.slice(0, MAX_DESCRIBE_FANOUT);
  const skippedCount = parsed.offloadedRefs.length - refsToDescribe.length;
  if (skippedCount > 0) {
    log?.warn(
      `describeOffloadedImages: capping at ${MAX_DESCRIBE_FANOUT} of ${parsed.offloadedRefs.length} offloaded images; ${skippedCount} will be neutralized`,
    );
    // Neutralize skipped markers so the runner doesn't try to parse them
    for (const ref of parsed.offloadedRefs.slice(MAX_DESCRIBE_FANOUT)) {
      const marker = `[media attached: ${ref.mediaRef}]`;
      updatedMessage = updatedMessage.replace(
        marker,
        "[image attached but not described: fanout cap reached]",
      );
    }
  }

  for (const ref of refsToDescribe) {
    try {
      // Resolve the physical file path from the media store
      const physicalPath = await resolveMediaBufferPath(ref.id, "inbound");

      // Describe the image using the vision-capable imageModel
      const result = await describeImageFileWithModel({
        filePath: physicalPath,
        cfg,
        agentDir,
        mime: ref.mimeType,
        provider: imageModel.provider,
        model: imageModel.model,
        prompt:
          "Describe this image concisely in 2-3 sentences. Focus on the main subject, key details, and any text visible in the image.",
        maxTokens: 200,
        timeoutMs: 30_000,
      });

      const description = result.text?.trim();
      if (description) {
        // Replace the media:// marker with a text description
        const marker = `[media attached: ${ref.mediaRef}]`;
        const replacement = `[attached image: ${description}]`;
        updatedMessage = updatedMessage.replace(marker, replacement);
        log?.info?.(
          `[Gateway] Described offloaded image ${ref.mediaRef} via ${imageModel.provider}/${imageModel.model}`,
        );
      } else {
        log?.warn(
          `describeOffloadedImages: imageModel returned empty description for ${ref.mediaRef}`,
        );
        // Neutralize marker so it doesn't get parsed as image ref
        const marker = `[media attached: ${ref.mediaRef}]`;
        updatedMessage = updatedMessage.replace(
          marker,
          "[image attached but description was empty]",
        );
      }
    } catch (err) {
      log?.warn(
        `describeOffloadedImages: failed to describe ${ref.mediaRef}: ${formatErrorMessage(err)}`,
      );
      // Neutralize the marker so it doesn't get parsed as an image ref downstream
      const marker = `[media attached: ${ref.mediaRef}]`;
      updatedMessage = updatedMessage.replace(
        marker,
        `[image attached but could not be described: description failed]`,
      );
    }
  }

  return {
    ...parsed,
    message: updatedMessage,
  };
}
