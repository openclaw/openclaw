import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  getImageMetadata,
  hasAlphaChannel,
  resizeToJpeg,
  resizeToPng,
} from "../media/image-ops.js";
import { saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";
import {
  DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_DIMENSION,
  DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_HEIGHT,
  DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_WIDTH,
} from "../shared/managed-image-thumbnail-limits.js";

const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing";
const THUMBNAIL_QUALITY = 82;
const DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS = 15 * 60 * 1000;

export const DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 20_000_000,
  thumbnailMaxDimension: DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_DIMENSION,
  thumbnailMaxWidth: DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_WIDTH,
  thumbnailMaxHeight: DEFAULT_INLINE_IMAGE_THUMBNAIL_MAX_HEIGHT,
} as const;

export type ManagedImageAttachmentLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  thumbnailMaxDimension: number;
  thumbnailMaxWidth: number;
  thumbnailMaxHeight: number;
};

type ManagedImageAttachmentLimitsConfig = Partial<
  Pick<
    ManagedImageAttachmentLimits,
    | "maxBytes"
    | "maxWidth"
    | "maxHeight"
    | "maxPixels"
    | "thumbnailMaxDimension"
    | "thumbnailMaxWidth"
    | "thumbnailMaxHeight"
  >
>;

type ManagedImageRecordVariant = {
  path: string;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedImageRetentionClass = "transient" | "history";

type ManagedImageRecord = {
  attachmentId: string;
  sessionKey: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedImageRetentionClass;
  alt: string;
  original: ManagedImageRecordVariant;
  thumbnail: ManagedImageRecordVariant;
};

type ParsedImageDataUrl =
  | { kind: "not-data-url" }
  | { kind: "non-image-data-url" }
  | { kind: "image-data-url"; buffer: Buffer; contentType: string };

type ManagedImageBlock = Record<string, unknown>;

type CleanupManagedOutgoingImageRecordsResult = {
  deletedRecordCount: number;
  deletedFileCount: number;
  retainedCount: number;
};

export function resolveManagedImageAttachmentLimits(
  config?: ManagedImageAttachmentLimitsConfig | null,
): ManagedImageAttachmentLimits {
  const thumbnailMaxDimension =
    config?.thumbnailMaxDimension ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.thumbnailMaxDimension;
  return {
    maxBytes: config?.maxBytes ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxBytes,
    maxWidth: config?.maxWidth ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxWidth,
    maxHeight: config?.maxHeight ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxHeight,
    maxPixels: config?.maxPixels ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxPixels,
    thumbnailMaxDimension,
    thumbnailMaxWidth:
      config?.thumbnailMaxWidth ??
      config?.thumbnailMaxDimension ??
      DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.thumbnailMaxWidth,
    thumbnailMaxHeight:
      config?.thumbnailMaxHeight ??
      config?.thumbnailMaxDimension ??
      DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.thumbnailMaxHeight,
  };
}

function formatLimitMiB(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${bytes} bytes`;
  }
  return Number.isInteger(bytes / (1024 * 1024))
    ? `${bytes / (1024 * 1024)} MiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function createManagedImageAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedImageAttachmentError";
  return error;
}

function isManagedImageAttachmentSafeError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "ManagedImageAttachmentError") {
    return true;
  }
  return (
    error.message.startsWith("Managed image attachment ") ||
    error.message.startsWith("Invalid image data URL")
  );
}

function throwSanitizedManagedImageAttachmentError(error: unknown, alt: string): never {
  if (isManagedImageAttachmentSafeError(error)) {
    throw error;
  }
  throw createManagedImageAttachmentError(
    `Managed image attachment ${JSON.stringify(alt)} could not be prepared`,
  );
}

function validateManagedImageBuffer(
  buffer: Buffer,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): void {
  if (buffer.byteLength > limits.maxBytes) {
    throw createManagedImageAttachmentError(
      `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
    );
  }
}

function getManagedImageMetadataLimitError(
  metadata: { width: number; height: number } | null,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): string | null {
  if (!metadata) {
    return `Managed image attachment ${JSON.stringify(alt)} is missing readable dimensions`;
  }

  if (metadata.width > limits.maxWidth) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxWidth}px width limit`;
  }
  if (metadata.height > limits.maxHeight) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxHeight}px height limit`;
  }
  if (metadata.width * metadata.height > limits.maxPixels) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxPixels.toLocaleString("en-US")} pixel limit`;
  }
  return null;
}

function validateManagedImageMetadata(
  metadata: { width: number; height: number } | null,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): void {
  const error = getManagedImageMetadataLimitError(metadata, alt, limits);
  if (error) {
    throw createManagedImageAttachmentError(error);
  }
}

function computeManagedImageResizeTarget(
  metadata: { width: number; height: number },
  limits: ManagedImageAttachmentLimits,
): { width: number; height: number } | null {
  const scale = Math.min(
    1,
    limits.maxWidth / metadata.width,
    limits.maxHeight / metadata.height,
    Math.sqrt(limits.maxPixels / (metadata.width * metadata.height)),
  );
  if (!Number.isFinite(scale) || scale >= 1) {
    return null;
  }

  let width = Math.max(1, Math.floor(metadata.width * scale));
  let height = Math.max(1, Math.floor(metadata.height * scale));
  while (
    width > limits.maxWidth ||
    height > limits.maxHeight ||
    width * height > limits.maxPixels
  ) {
    if (width >= height && width > 1) {
      width -= 1;
    } else if (height > 1) {
      height -= 1;
    } else {
      break;
    }
  }
  return { width, height };
}

async function resizeManagedImageBufferToLimits(params: {
  buffer: Buffer;
  metadata: { width: number; height: number };
  limits: ManagedImageAttachmentLimits;
}): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }> {
  const target = computeManagedImageResizeTarget(params.metadata, params.limits);
  if (!target) {
    return {
      buffer: params.buffer,
      contentType: "image/jpeg",
      width: params.metadata.width,
      height: params.metadata.height,
    };
  }

  const preserveAlpha = await hasAlphaChannel(params.buffer).catch(() => false);
  const resizedBuffer = preserveAlpha
    ? await resizeToPng({
        buffer: params.buffer,
        maxWidth: target.width,
        maxHeight: target.height,
        compressionLevel: 9,
        withoutEnlargement: true,
      })
    : await resizeToJpeg({
        buffer: params.buffer,
        maxWidth: target.width,
        maxHeight: target.height,
        quality: 92,
        withoutEnlargement: true,
      });

  return {
    buffer: resizedBuffer,
    contentType: preserveAlpha ? "image/png" : "image/jpeg",
    width: target.width,
    height: target.height,
  };
}

function resolveOutgoingRecordsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing", "records");
}

function resolveOutgoingOriginalsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing", "originals");
}

function resolveOutgoingThumbnailsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing", "thumbs");
}

function resolveOutgoingRecordPath(attachmentId: string, stateDir = resolveStateDir()) {
  return path.join(resolveOutgoingRecordsDir(stateDir), `${attachmentId}.json`);
}

function buildOutgoingVariantUrl(
  sessionKey: string,
  attachmentId: string,
  variant: "thumb" | "full" | "download",
) {
  return `${OUTGOING_IMAGE_ROUTE_PREFIX}/${encodeURIComponent(sessionKey)}/${attachmentId}/${variant}`;
}

function resolveRequesterSessionKey(req: IncomingMessage) {
  const raw = req.headers["x-openclaw-requester-session-key"];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() || null;
  }
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

async function requesterOwnsManagedImageSession(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}) {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  const subagentRun = getLatestSubagentRunByChildSessionKey(params.targetSessionKey);
  if (!subagentRun) {
    return false;
  }
  return (
    subagentRun.requesterSessionKey === params.requesterSessionKey ||
    subagentRun.controllerSessionKey === params.requesterSessionKey
  );
}

function deriveAltText(source: string, index: number) {
  const fallback = `Generated image ${index + 1}`;
  try {
    if (/^https?:\/\//i.test(source)) {
      const parsed = new URL(source);
      const name = path.basename(parsed.pathname || "").trim();
      return name || fallback;
    }
  } catch {
    // Fall through to local path handling.
  }
  const localName = path.basename(source).trim();
  return localName || fallback;
}

function shouldCopyOriginalAsThumbnail(params: {
  metadata: { width: number; height: number } | null;
  limits: ManagedImageAttachmentLimits;
}) {
  if (!params.metadata) {
    return false;
  }
  return (
    params.metadata.width <= params.limits.thumbnailMaxWidth &&
    params.metadata.height <= params.limits.thumbnailMaxHeight
  );
}

function parseImageDataUrl(source: string): ParsedImageDataUrl {
  const trimmed = source.trim();
  if (!trimmed.startsWith("data:")) {
    return { kind: "not-data-url" };
  }
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Invalid image data URL");
  }
  const contentType = match[1]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    return { kind: "non-image-data-url" };
  }
  return {
    kind: "image-data-url",
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
    contentType,
  };
}

async function getVariantStats(filePath: string) {
  const [stats, metadataBuffer] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
  const metadata = await getImageMetadata(metadataBuffer).catch(() => ({ width: null, height: null }));
  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    sizeBytes: Number.isFinite(stats.size) ? stats.size : null,
  };
}

async function writeManagedImageRecord(record: ManagedImageRecord, stateDir = resolveStateDir()) {
  const recordPath = resolveOutgoingRecordPath(record.attachmentId, stateDir);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf-8");
}

async function deleteManagedImageRecordArtifacts(
  record: ManagedImageRecord,
  stateDir = resolveStateDir(),
) {
  const files = new Set<string>();
  if (record.original?.path) {
    files.add(record.original.path);
  }
  if (record.thumbnail?.path) {
    files.add(record.thumbnail.path);
  }
  let deletedFileCount = 0;
  for (const filePath of files) {
    try {
      await fs.rm(filePath, { force: true });
      deletedFileCount += 1;
    } catch {
      // Ignore cleanup races or already-missing files.
    }
  }
  try {
    await fs.rm(resolveOutgoingRecordPath(record.attachmentId, stateDir), { force: true });
  } catch {
    // Ignore cleanup races or already-missing records.
  }
  return deletedFileCount;
}

async function deleteOrphanManagedImageFiles(params: {
  stateDir: string;
  referencedPaths: ReadonlySet<string>;
}) {
  let deletedFileCount = 0;
  for (const dir of [
    resolveOutgoingOriginalsDir(params.stateDir),
    resolveOutgoingThumbnailsDir(params.stateDir),
  ]) {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const filePath = path.join(dir, name);
      if (params.referencedPaths.has(filePath)) {
        continue;
      }
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      try {
        await fs.rm(filePath, { force: true });
        deletedFileCount += 1;
      } catch {
        // Ignore cleanup races or already-missing files.
      }
    }
  }
  return deletedFileCount;
}

export async function cleanupManagedOutgoingImageRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  forceDeleteSessionRecords?: boolean;
}): Promise<CleanupManagedOutgoingImageRecordsResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs =
    params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const recordsDir = resolveOutgoingRecordsDir(stateDir);
  let names: string[] = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    names = [];
  }

  let deletedRecordCount = 0;
  let deletedFileCount = 0;
  let retainedCount = 0;
  const referencedPaths = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const recordPath = path.join(recordsDir, name);
    let record: ManagedImageRecord;
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf-8")) as ManagedImageRecord;
    } catch {
      try {
        await fs.rm(recordPath, { force: true });
      } catch {
        // Ignore cleanup races or already-missing records.
      }
      deletedRecordCount += 1;
      continue;
    }
    if (sessionKeyFilter && record.sessionKey !== sessionKeyFilter) {
      retainedCount += 1;
      continue;
    }

    let shouldDelete = false;
    if (forceDeleteSessionRecords && (!sessionKeyFilter || record.sessionKey === sessionKeyFilter)) {
      shouldDelete = true;
    } else if (record.messageId) {
      shouldDelete = !(await recordMatchesTranscriptMessage(record));
    } else {
      const createdAtMs = Date.parse(record.createdAt);
      shouldDelete = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= transientMaxAgeMs;
    }

    if (shouldDelete) {
      deletedRecordCount += 1;
      deletedFileCount += await deleteManagedImageRecordArtifacts(record, stateDir);
    } else {
      if (record.original?.path) {
        referencedPaths.add(record.original.path);
      }
      if (record.thumbnail?.path) {
        referencedPaths.add(record.thumbnail.path);
      }
      retainedCount += 1;
    }
  }

  deletedFileCount += await deleteOrphanManagedImageFiles({ stateDir, referencedPaths });

  return { deletedRecordCount, deletedFileCount, retainedCount };
}

async function readManagedImageRecord(
  attachmentId: string,
  stateDir = resolveStateDir(),
): Promise<ManagedImageRecord | null> {
  try {
    const raw = await fs.readFile(resolveOutgoingRecordPath(attachmentId, stateDir), "utf-8");
    return JSON.parse(raw) as ManagedImageRecord;
  } catch {
    return null;
  }
}

function buildManagedImageBlock(record: ManagedImageRecord): ManagedImageBlock {
  return {
    type: "image",
    url: buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "thumb"),
    openUrl: buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full"),
    downloadUrl: buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "download"),
    alt: record.alt,
    mimeType: record.thumbnail.contentType,
    width: record.thumbnail.width,
    height: record.thumbnail.height,
  };
}

function buildManagedImageResizeWarningBlock(params: {
  alt: string;
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
}): ManagedImageBlock {
  return {
    type: "text",
    text:
      `[Image warning] ${params.alt} exceeded gateway dimension/pixel limits and was resized from ` +
      `${params.originalWidth}×${params.originalHeight} to ${params.resizedWidth}×${params.resizedHeight}.`,
  };
}

function toRecordFilename(filePath: string) {
  const name = path.basename(filePath).trim();
  return name || null;
}

function asArray(value: string[] | undefined | null) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function parseManagedOutgoingRoute(value: string) {
  try {
    const parsed = new URL(value, "http://localhost");
    const match = parsed.pathname.match(
      /^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/(thumb|full|download)$/,
    );
    if (!match) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(match[1]),
      attachmentId: match[2],
      variant: match[3] as "thumb" | "full" | "download",
    };
  } catch {
    return null;
  }
}

function collectManagedOutgoingAttachmentRefs(
  blocks: readonly Record<string, unknown>[] | undefined,
  expectedSessionKey?: string,
) {
  const refs = new Map<string, { attachmentId: string; sessionKey: string }>();
  for (const block of blocks ?? []) {
    if (block?.type !== "image") {
      continue;
    }
    for (const candidate of [block.url, block.openUrl, block.downloadUrl]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const parsed = parseManagedOutgoingRoute(candidate);
      if (!parsed) {
        continue;
      }
      if (expectedSessionKey && parsed.sessionKey !== expectedSessionKey) {
        continue;
      }
      refs.set(parsed.attachmentId, {
        attachmentId: parsed.attachmentId,
        sessionKey: parsed.sessionKey,
      });
    }
  }
  return [...refs.values()];
}

function messageContainsManagedOutgoingAttachment(
  message: unknown,
  expected: { sessionKey: string; attachmentId: string },
) {
  const content = Array.isArray((message as { content?: unknown[] } | null)?.content)
    ? ((message as { content: unknown[] }).content as Record<string, unknown>[])
    : [];
  return collectManagedOutgoingAttachmentRefs(content, expected.sessionKey).some(
    (ref) => ref.attachmentId === expected.attachmentId,
  );
}

async function recordMatchesTranscriptMessage(record: ManagedImageRecord) {
  if (!record.messageId) {
    return false;
  }
  const { storePath, entry } = loadSessionEntry(record.sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return false;
  }
  const messages = readSessionMessages(sessionId, storePath, entry.sessionFile);
  return messages.some((message) => {
    const meta = (message as { __openclaw?: { id?: string } } | null)?.__openclaw;
    return (
      meta?.id === record.messageId &&
      messageContainsManagedOutgoingAttachment(message, {
        sessionKey: record.sessionKey,
        attachmentId: record.attachmentId,
      })
    );
  });
}

export async function attachManagedOutgoingImagesToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
}) {
  const messageId = params.messageId.trim();
  if (!messageId) {
    return;
  }
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (refs.length === 0) {
    return;
  }
  await Promise.all(
    refs.map(async ({ attachmentId, sessionKey }) => {
      const record = await readManagedImageRecord(attachmentId, params.stateDir);
      if (!record || record.sessionKey !== sessionKey) {
        return;
      }
      if (record.messageId === messageId && record.retentionClass === "history") {
        return;
      }
      await writeManagedImageRecord(
        {
          ...record,
          messageId,
          retentionClass: "history",
          updatedAt: new Date().toISOString(),
        },
        params.stateDir,
      );
    }),
  );
}

export async function createManagedOutgoingImageBlocks(params: {
  sessionKey: string;
  mediaUrls?: string[] | null;
  stateDir?: string;
  messageId?: string | null;
  limits?: ManagedImageAttachmentLimitsConfig | null;
}): Promise<ManagedImageBlock[]> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }
  const mediaUrls = asArray(params.mediaUrls);
  if (mediaUrls.length === 0) {
    return [];
  }
  const stateDir = params.stateDir ?? resolveStateDir();
  const limits = resolveManagedImageAttachmentLimits(params.limits);
  await cleanupManagedOutgoingImageRecords({ stateDir });
  const blocks: ManagedImageBlock[] = [];
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const parsedDataUrl = parseImageDataUrl(mediaUrl);
    const alt =
      parsedDataUrl.kind === "image-data-url"
        ? `Generated image ${index + 1}`
        : deriveAltText(mediaUrl, index);
    if (parsedDataUrl.kind === "non-image-data-url") {
      continue;
    }

    let savedOriginalPath: string | null = null;
    let savedThumbnailPath: string | null = null;
    try {
      let resizeWarning: ManagedImageBlock | null = null;
      if (parsedDataUrl.kind === "image-data-url") {
        validateManagedImageBuffer(parsedDataUrl.buffer, alt, limits);
      }
      let savedOriginal =
        parsedDataUrl.kind === "image-data-url"
          ? await saveMediaBuffer(
              parsedDataUrl.buffer,
              parsedDataUrl.contentType,
              "outgoing/originals",
              limits.maxBytes,
              `generated-image-${index + 1}`,
            )
          : await saveMediaSource(mediaUrl, undefined, "outgoing/originals");
      savedOriginalPath = savedOriginal.path;
      if (savedOriginal.size > limits.maxBytes) {
        throw createManagedImageAttachmentError(
          `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }
      if (!savedOriginal.contentType?.startsWith("image/")) {
        continue;
      }

      let originalBuffer =
        parsedDataUrl.kind === "image-data-url"
          ? parsedDataUrl.buffer
          : await fs.readFile(savedOriginal.path);
      validateManagedImageBuffer(originalBuffer, alt, limits);

      let originalStats = await getVariantStats(savedOriginal.path);
      if (originalStats.sizeBytes != null && originalStats.sizeBytes > limits.maxBytes) {
        throw createManagedImageAttachmentError(
          `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }

      const originalMetadata =
        originalStats.width != null && originalStats.height != null
          ? { width: originalStats.width, height: originalStats.height }
          : await getImageMetadata(originalBuffer);
      let effectiveMetadata = originalMetadata;
      let metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, alt, limits);
      for (let resizeAttempt = 0; metadataLimitError; resizeAttempt += 1) {
        if (!effectiveMetadata) {
          throw createManagedImageAttachmentError(metadataLimitError);
        }
        if (resizeAttempt >= 3) {
          throw createManagedImageAttachmentError(metadataLimitError);
        }
        const resized = await resizeManagedImageBufferToLimits({
          buffer: originalBuffer,
          metadata: effectiveMetadata,
          limits,
        });
        validateManagedImageBuffer(resized.buffer, alt, limits);
        const replacement = await saveMediaBuffer(
          resized.buffer,
          resized.contentType,
          "outgoing/originals",
          limits.maxBytes,
          toRecordFilename(savedOriginal.path) ?? `generated-image-${index + 1}`,
        );
        await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
        savedOriginal = replacement;
        savedOriginalPath = savedOriginal.path;
        originalBuffer = resized.buffer;
        originalStats = await getVariantStats(savedOriginal.path);
        effectiveMetadata =
          originalStats.width != null && originalStats.height != null
            ? { width: originalStats.width, height: originalStats.height }
            : await getImageMetadata(originalBuffer);
        metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, alt, limits);
        if (!metadataLimitError) {
          resizeWarning = buildManagedImageResizeWarningBlock({
            alt,
            originalWidth: originalMetadata?.width ?? effectiveMetadata?.width ?? resized.width,
            originalHeight: originalMetadata?.height ?? effectiveMetadata?.height ?? resized.height,
            resizedWidth: effectiveMetadata?.width ?? resized.width,
            resizedHeight: effectiveMetadata?.height ?? resized.height,
          });
        }
      }

      const thumbnailBuffer = shouldCopyOriginalAsThumbnail({
        metadata:
          originalStats.width != null && originalStats.height != null
            ? { width: originalStats.width, height: originalStats.height }
            : originalMetadata,
        limits,
      })
        ? originalBuffer
        : await resizeToJpeg({
            buffer: originalBuffer,
            maxWidth: limits.thumbnailMaxWidth,
            maxHeight: limits.thumbnailMaxHeight,
            quality: THUMBNAIL_QUALITY,
            withoutEnlargement: true,
          });
      const savedThumbnail = await saveMediaBuffer(
        thumbnailBuffer,
        thumbnailBuffer === originalBuffer ? savedOriginal.contentType : "image/jpeg",
        "outgoing/thumbs",
        limits.maxBytes,
        thumbnailBuffer === originalBuffer
          ? toRecordFilename(savedOriginal.path) ?? `generated-image-${index + 1}`
          : undefined,
      );
      savedThumbnailPath = savedThumbnail.path;
      const thumbnailStats = await getVariantStats(savedThumbnail.path);
      const record: ManagedImageRecord = {
        attachmentId: randomUUID(),
        sessionKey,
        messageId: params.messageId ?? null,
        createdAt: new Date().toISOString(),
        retentionClass: params.messageId ? "history" : "transient",
        alt,
        original: {
          path: savedOriginal.path,
          contentType: savedOriginal.contentType ?? "application/octet-stream",
          width: originalStats.width,
          height: originalStats.height,
          sizeBytes: originalStats.sizeBytes,
          filename: toRecordFilename(savedOriginal.path),
        },
        thumbnail: {
          path: savedThumbnail.path,
          contentType: savedThumbnail.contentType ?? "image/jpeg",
          width: thumbnailStats.width,
          height: thumbnailStats.height,
          sizeBytes: thumbnailStats.sizeBytes,
          filename: toRecordFilename(savedThumbnail.path),
        },
      };
      await writeManagedImageRecord(record, stateDir);
      blocks.push(buildManagedImageBlock(record));
      if (resizeWarning) {
        blocks.push(resizeWarning);
      }
    } catch (error) {
      await Promise.all([
        savedOriginalPath ? fs.rm(savedOriginalPath, { force: true }).catch(() => {}) : undefined,
        savedThumbnailPath ? fs.rm(savedThumbnailPath, { force: true }).catch(() => {}) : undefined,
      ]);
      throwSanitizedManagedImageAttachmentError(error, alt);
    }
  }
  return blocks;
}

function sendStatus(res: ServerResponse, statusCode: number, body: string) {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function safeAttachmentFilename(value: string | null) {
  const fallback = "generated-image";
  const base = (value ?? fallback).replace(/[\r\n"\\]/g, "_").trim();
  return base || fallback;
}

export async function handleManagedOutgoingImageHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    stateDir?: string;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const match = requestUrl.pathname.match(
    /^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/(thumb|full|download)$/,
  );
  if (!match) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    pairedDeviceTokenFallback: {
      role: "operator",
      scopes: [],
      baseDir: opts.stateDir,
    },
  });
  if (!requestAuth) {
    return true;
  }

  const privilegedAccess =
    
    requestAuth.trustDeclaredOperatorScopes || requestAuth.authMethod === "device-token";

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return true;
  }

  const encodedSessionKey = match[1];
  const attachmentId = match[2];
  const variant = match[3];
  if (!encodedSessionKey || !attachmentId || !variant) {
    return false;
  }
  const sessionKey = decodeURIComponent(encodedSessionKey);
  const record = await readManagedImageRecord(attachmentId, opts.stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    sendStatus(res, 404, "not found");
    return true;
  }
  if (!privilegedAccess) {
    const requesterSessionKey = resolveRequesterSessionKey(req);
    if (!requesterSessionKey) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "requester session ownership required",
        },
      });
      return true;
    }
    const ownsSession = await requesterOwnsManagedImageSession({
      requesterSessionKey,
      targetSessionKey: record.sessionKey,
    });
    if (!ownsSession) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "requester session does not own attachment session",
        },
      });
      return true;
    }
  }
  if (!(await recordMatchesTranscriptMessage(record))) {
    sendStatus(res, 404, "not found");
    return true;
  }

  const selected = variant === "thumb" ? record.thumbnail : record.original;
  let body: Buffer;
  try {
    body = await fs.readFile(selected.path);
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", selected.contentType || "application/octet-stream");
  res.setHeader("content-length", String(body.byteLength));
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  const dispositionType = variant === "download" ? "attachment" : "inline";
  res.setHeader(
    "content-disposition",
    `${dispositionType}; filename="${safeAttachmentFilename(selected.filename)}"`,
  );
  res.end(body);
  return true;
}
