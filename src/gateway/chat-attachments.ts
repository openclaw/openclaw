import { MAX_IMAGE_BYTES, type MediaKind } from "@openclaw/media-core/constants";
import { extensionForMime, kindFromMime, normalizeMimeType } from "@openclaw/media-core/mime";
import type { Static } from "typebox";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { ChatAttachmentSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { prepareMediaAttachment } from "../media/attachment-processor.js";
import {
  ATTACHMENT_OFFLOAD_THRESHOLD_BYTES,
  isGenericContainerMime,
} from "../media/attachment-processor.runtime.js";
import { parseInboundMediaUri } from "../media/inbound-media-uri.js";
import type { MediaFact } from "../media/media-facts.js";
import { probeMediaFilesWithinBudget } from "../media/media-probe.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { deleteMediaBuffer, saveMediaBuffer, type SavedMedia } from "../media/store.js";
import { DEFAULT_CHAT_ATTACHMENT_MAX_BYTES } from "./chat-attachment-policy.js";
import { registerMediaCleanupDrain } from "./server-media-cleanup-lifecycle.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { formatForLog } from "./ws-log.js";

export type ChatAttachment = SchemaContract<Omit<Static<typeof ChatAttachmentSchema>, "origin">> & {
  origin?: MediaFact["origin"];
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  fileName?: string;
  sourceIndex: number;
};

export type OffloadedRef = {
  mediaRef: string;
  id: string;
  path: string;
  kind: MediaKind;
  mimeType: string;
  label: string;
  origin?: MediaFact["origin"];
  sizeBytes: number;
  sourceIndex: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

function projectOffloadedMediaFact(ref: OffloadedRef, durable: boolean): MediaFact {
  const fact: MediaFact = {
    ...(durable ? {} : { path: ref.path }),
    url: durable ? buildManagedInboundMediaRef(ref.id) : ref.mediaRef,
    contentType: ref.mimeType,
    kind: ref.kind,
    fileName: ref.label,
    ...(ref.origin ? { origin: ref.origin } : {}),
    sizeBytes: ref.sizeBytes,
  };
  for (const field of ["durationMs", "width", "height"] as const) {
    // Durable facts preserve measured zeroes; parsed input retains its existing omission policy.
    if (durable ? ref[field] !== undefined : ref[field]) {
      fact[field] = ref[field];
    }
  }
  if (durable && !ref.mimeType.startsWith("image/")) {
    fact.hydrationSuppressed = true;
  }
  return fact;
}

/** Deletes prepared inbound files that never reached a durable owner. */
export async function discardPreparedInboundMedia(
  refs: readonly Pick<OffloadedRef, "id">[],
  log?: { warn: (message: string) => void },
): Promise<void> {
  const deletion = Promise.allSettled(refs.map((ref) => deleteMediaBuffer(ref.id, "inbound")));
  // Request cleanup can detach after ACK or rejection; shutdown still owns its file removals.
  registerMediaCleanupDrain(deletion.then(() => undefined));
  const results = await deletion;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected" && log) {
      log.warn(
        `failed to discard prepared inbound media ${refs[index]?.id}: ${formatErrorMessage(result.reason)}`,
      );
    }
  }
}

type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  media: MediaFact[];
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

export const INLINE_IMAGE_DURABLE_OMISSION_MARKER =
  "[image attachment omitted: durable managed media claim unavailable]";

type PersistInboundImagesResult = {
  entries: Array<{
    id: string;
    path: string;
    sourceIndex: number;
    imageKind?: PromptImageOrderEntry;
    fact: MediaFact;
  }>;
  omission: "none" | "inline-image-save-failed";
};

const TEXT_ONLY_OFFLOAD_LIMIT = 10;
const MAX_CHAT_ATTACHMENT_MEDIA_PROBES = 8;
const CHAT_ATTACHMENT_MEDIA_PROBE_CONCURRENCY = 2;
const CHAT_ATTACHMENT_MEDIA_PROBE_BUDGET_MS = 3000;

async function enrichOffloadedMediaMetadata(refs: OffloadedRef[]): Promise<void> {
  const candidates = refs.flatMap((ref) => {
    const kind = kindFromMime(ref.mimeType);
    return kind === "audio" || kind === "video" ? [{ kind, ref }] : [];
  });
  const metadata = await probeMediaFilesWithinBudget(
    candidates.map(({ kind, ref }) => ({ filePath: ref.path, kind })),
    {
      budgetMs: CHAT_ATTACHMENT_MEDIA_PROBE_BUDGET_MS,
      concurrency: CHAT_ATTACHMENT_MEDIA_PROBE_CONCURRENCY,
      maxProbes: MAX_CHAT_ATTACHMENT_MEDIA_PROBES,
    },
  );
  for (const [index, candidate] of candidates.entries()) {
    Object.assign(candidate.ref, metadata[index]);
  }
}

export function logAttachmentFailure(
  log: Pick<SubsystemLogger, "error">,
  label: string,
  err: unknown,
): void {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const causeText = cause === undefined ? "" : formatUncaughtError(cause);
  log.error(label, {
    error: !causeText || causeText === primary ? primary : `${primary}\nCaused by: ${causeText}`,
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

export function stripImageMediaMarkers(message: string, refs: readonly OffloadedRef[]): string {
  return refs.reduce((projected, ref) => {
    const marker = ref.mimeType.startsWith("image/") ? `\n[media attached: ${ref.mediaRef}]` : "";
    const index = marker ? projected.lastIndexOf(marker) : -1;
    return index < 0
      ? projected
      : projected.slice(0, index) + projected.slice(index + marker.length);
  }, message);
}

export async function persistInboundImagesForTranscript(params: {
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  log: Pick<AttachmentLog, "warn">;
  logContext: string;
  assertCurrent?: () => void;
}): Promise<PersistInboundImagesResult> {
  const entries: PersistInboundImagesResult["entries"] = [];
  let omission: PersistInboundImagesResult["omission"] = "none";
  try {
    params.assertCurrent?.();
    for (const image of params.images) {
      try {
        params.assertCurrent?.();
        const saved = await saveMediaBuffer(
          Buffer.from(image.data, "base64"),
          image.mimeType,
          "inbound",
          undefined,
          image.fileName,
          undefined,
          { assertCommitAllowed: params.assertCurrent },
        );
        entries.push({
          id: saved.id,
          path: saved.path,
          sourceIndex: image.sourceIndex,
          imageKind: "inline",
          fact: {
            url: buildManagedInboundMediaRef(saved.id),
            contentType: saved.contentType ?? image.mimeType,
            kind: "image",
            ...(image.fileName ? { fileName: image.fileName } : {}),
            sizeBytes: saved.size,
          },
        });
      } catch (err) {
        // An ended input admission is not a best-effort image omission.
        if (err instanceof SessionMutationAuthorizationChangedError) {
          throw err;
        }
        params.assertCurrent?.();
        omission = "inline-image-save-failed";
        params.log.warn(
          `${params.logContext}: failed to persist inbound image (${image.mimeType}): ${formatErrorMessage(err)}`,
        );
      }
    }

    params.assertCurrent?.();
  } catch (error) {
    await discardPreparedInboundMedia(entries, params.log);
    throw error;
  }

  for (const ref of params.offloadedRefs) {
    const fact = projectOffloadedMediaFact(ref, true);
    entries.push({
      id: ref.id,
      path: ref.path,
      sourceIndex: ref.sourceIndex,
      ...(ref.mimeType.startsWith("image/") ? { imageKind: "offloaded" as const } : {}),
      fact,
    });
  }
  entries.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return { entries, omission };
}

type UnsupportedAttachmentReason =
  | "empty-payload"
  | "text-only-image"
  | "unsupported-non-image"
  | "non-image-too-large-for-sandbox";

export class UnsupportedAttachmentError extends Error {
  readonly reason: UnsupportedAttachmentReason;
  constructor(reason: UnsupportedAttachmentReason, message: string) {
    super(message);
    this.name = "UnsupportedAttachmentError";
    this.reason = reason;
  }
}

export class MediaOffloadError extends Error {
  override readonly cause: unknown;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaOffloadError";
    this.cause = options?.cause;
  }
}

function ensureExtension(label: string, mime: string): string {
  if (/\.[a-zA-Z0-9]+$/.test(label)) {
    return label;
  }
  const ext = extensionForMime(mime) ?? "";
  return ext ? `${label}${ext}` : label;
}

function buildManagedInboundMediaRef(id: string): string {
  const candidate = `media://inbound/${id}`;
  const parsed = parseInboundMediaUri(candidate);
  if (!parsed || parsed.id !== id) {
    throw new Error("Saved media ID failed canonical validation");
  }
  return parsed.normalizedSource;
}

function normalizeAttachment(att: ChatAttachment, idx: number): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  let base64 = content.trim();
  // Inspect metadata only; never capture a multi-megabyte payload in a regex.
  const commaIndex = base64.startsWith("data:") ? base64.indexOf(",") : -1;
  if (commaIndex >= 0 && /^data:[^;,]+;base64$/.test(base64.slice(0, commaIndex))) {
    base64 = base64.slice(commaIndex + 1);
  }
  return { label, mime, base64 };
}

export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    supportsImages?: boolean | (() => Promise<boolean>);
    supportsInlineImages?: boolean;
    acceptNonImage?: boolean;
    /** Ephemeral image-only callers keep bounded image bytes in their request, not the media store. */
    imageStorage?: "inline";
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_CHAT_ATTACHMENT_MAX_BYTES;
  const log = opts?.log;
  const supportsInlineImages = opts?.supportsInlineImages !== false;
  const acceptNonImage = opts?.acceptNonImage !== false;
  const supportsImagesOption = opts?.supportsImages;
  let resolvedSupportsImages =
    typeof supportsImagesOption === "boolean" ? supportsImagesOption : undefined;
  const resolveSupportsImages = async (): Promise<boolean> => {
    if (resolvedSupportsImages !== undefined) {
      return resolvedSupportsImages;
    }
    resolvedSupportsImages =
      typeof supportsImagesOption === "function" ? await supportsImagesOption() : true;
    return resolvedSupportsImages;
  };

  if (!attachments || attachments.length === 0) {
    return {
      message,
      images: [],
      imageOrder: [],
      media: [],
      offloadedRefs: [],
    };
  }

  const images: ChatImageContent[] = [];
  const imageOrder: PromptImageOrderEntry[] = [];
  const offloadedRefs: OffloadedRef[] = [];
  let updatedMessage = message;
  let textOnlyImageOffloadCount = 0;
  const savedMediaIds: string[] = [];

  try {
    opts?.assertCurrent?.();
    for (const [idx, att] of attachments.entries()) {
      if (!att) {
        continue;
      }

      const { base64: b64, label, mime } = normalizeAttachment(att, idx);

      if (b64.length === 0) {
        throw new UnsupportedAttachmentError("empty-payload", `attachment ${label}: empty payload`);
      }
      const prepared = await prepareMediaAttachment(
        { base64: b64, label, mime, imageStorage: opts?.imageStorage },
        maxBytes,
        opts?.signal,
      );
      const { sizeBytes, mime: finalMime } = prepared;
      const providedMime = normalizeMimeType(mime);

      if (providedMime && !isGenericContainerMime(providedMime) && finalMime !== providedMime) {
        log?.warn(`attachment ${label}: mime mismatch (${providedMime} -> ${finalMime})`);
      }

      const isImage = finalMime.startsWith("image/");
      const shouldForceImageOffload = isImage && !(await resolveSupportsImages());
      opts?.signal?.throwIfAborted();
      opts?.assertCurrent?.();
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
      // ceiling because their host path (media facts → Read/Bash) doesn't
      // load into the model.
      if (isImage && sizeBytes > MAX_IMAGE_BYTES) {
        throw new Error(
          `attachment ${label}: image exceeds size limit (${sizeBytes} > ${MAX_IMAGE_BYTES} bytes)`,
        );
      }

      if (shouldForceImageOffload && textOnlyImageOffloadCount >= TEXT_ONLY_OFFLOAD_LIMIT) {
        log?.warn(
          `attachment ${label}: dropping image because text-only offload limit ` +
            `${TEXT_ONLY_OFFLOAD_LIMIT} was reached`,
        );
        updatedMessage += "\n[image attachment omitted: text-only attachment limit reached]";
        continue;
      }

      const shouldOffload =
        shouldForceImageOffload ||
        !isImage ||
        (opts?.imageStorage !== "inline" && sizeBytes > ATTACHMENT_OFFLOAD_THRESHOLD_BYTES);

      if (!shouldOffload) {
        images.push({
          type: "image",
          data: b64,
          mimeType: finalMime,
          ...(att.fileName ? { fileName: att.fileName } : {}),
          sourceIndex: idx,
        });
        imageOrder.push("inline");
        continue;
      }

      opts?.assertCurrent?.();
      const bytes = prepared.buffer;
      const buffer = bytes
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Buffer.from(b64, "base64");

      let savedMedia: SavedMedia;
      let mediaRef: string;
      try {
        const labelWithExt = ensureExtension(label, finalMime);
        savedMedia = await saveMediaBuffer(
          buffer,
          finalMime,
          "inbound",
          maxBytes,
          labelWithExt,
          undefined,
          { assertCommitAllowed: opts?.assertCurrent },
        );
        mediaRef = buildManagedInboundMediaRef(savedMedia.id);
      } catch (err) {
        if (err instanceof SessionMutationAuthorizationChangedError) {
          throw err;
        }
        opts?.assertCurrent?.();
        throw new MediaOffloadError(
          `[Gateway Error] Failed to save intercepted media to disk: ${formatErrorMessage(err)}`,
          { cause: err },
        );
      }

      savedMediaIds.push(savedMedia.id);

      updatedMessage += `\n[media attached: ${mediaRef}]`;
      log?.info?.(
        shouldForceImageOffload
          ? `[Gateway] Offloaded image for text-only model. Saved: ${mediaRef}`
          : `[Gateway] Offloaded attachment (${finalMime}). Saved: ${mediaRef}`,
      );

      const offloaded: OffloadedRef = {
        mediaRef,
        id: savedMedia.id,
        path: savedMedia.path,
        kind: kindFromMime(finalMime) ?? "unknown",
        mimeType: finalMime,
        label,
        sizeBytes,
        sourceIndex: idx,
        ...(att.origin === "paste" || att.origin === "file" ? { origin: att.origin } : {}),
      };
      for (const field of ["durationMs", "width", "height"] as const) {
        const value = att[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          offloaded[field] = value;
        }
      }
      offloadedRefs.push(offloaded);
      if (isImage) {
        imageOrder.push("offloaded");
        if (shouldForceImageOffload) {
          textOnlyImageOffloadCount++;
        }
      }
    }
    await enrichOffloadedMediaMetadata(offloadedRefs);
    opts?.assertCurrent?.();
  } catch (err) {
    if (savedMediaIds.length > 0) {
      await Promise.allSettled(savedMediaIds.map((id) => deleteMediaBuffer(id, "inbound")));
    }
    if (err instanceof WorkerTaskError && err !== opts?.signal?.reason) {
      if (err.code === "failed") {
        throw new Error(err.message, { cause: err });
      }
      throw new MediaOffloadError(
        `[Gateway Error] Failed to prepare attachments: ${formatErrorMessage(err)}`,
        { cause: err },
      );
    }
    throw err;
  }

  return {
    message: updatedMessage !== message ? updatedMessage.trimEnd() : message,
    images,
    imageOrder,
    media: offloadedRefs.map((ref) => projectOffloadedMediaFact(ref, false)),
    offloadedRefs,
  };
}
