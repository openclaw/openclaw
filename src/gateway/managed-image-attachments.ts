import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
import { maxBytesForKind, mediaKindFromMime } from "@openclaw/media-core/constants";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ReplyMediaAttachment,
  ReplyMediaFailureCode,
  ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveDeliveryQueueStateEnv } from "../infra/delivery-queue-sqlite.js";
import { openLocalFileSafely, readLocalFileSafely } from "../infra/fs-safe.js";
import { collectReplyMediaEntries } from "../infra/outbound/reply-media-entries.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { WEBCHAT_LOCAL_MEDIA_MAX_BYTES } from "../media/configured-max-bytes.js";
import { assertLocalMediaAllowed, resolveLocalMediaRoots } from "../media/local-media-access.js";
import { resolveLocalMediaPath } from "../media/local-media-path.js";
import { createImageProcessor, getImageMetadata } from "../media/media-services.js";
import {
  PlaybackInspectionBusyError,
  replacePlaybackFileExtension,
  resolvePlaybackMetadataForSource,
  resolvePlaybackTranscode,
} from "../media/playback-transcode.js";
import { MEDIA_MAX_BYTES, saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { unlinkIfExists } from "../media/temp-files.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import {
  captureChannelReadScope,
  withChannelReadAuthority,
} from "../shared/channel-read-authority.js";
import { normalizeChatImageRenditionWidth } from "../shared/chat-image-renditions.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  assertArtifactDownloadGrantCurrent,
  resolveArtifactDownloadGrant,
  retainArtifactDownloadStream,
} from "./artifact-download-grants.js";
import { buildManagedMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  createGatewayByteStream,
  createImmutableFileValidators,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";
import { sendJson, sendMethodNotAllowed, sendMissingScopeForbidden } from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import {
  resolveManagedImageOriginalPath,
  deleteAgedOrphanManagedImageFiles,
  deleteManagedImageRecordArtifacts,
  insertManagedImageRecordWithFile,
} from "./managed-image-attachments.custody.js";
import {
  createManagedImageAttachmentError,
  getSanitizedManagedImageAttachmentError,
} from "./managed-image-attachments.errors.js";
import {
  formatLimitMiB,
  maxBytesForManagedMediaKind,
  resolveManagedMediaKind,
  type ManagedMediaKind,
} from "./managed-image-attachments.media-kind.js";
import {
  attachManagedImageRecordsToMessage,
  captureManagedImageContext,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "./managed-image-record-store.js";
import { withManagedImageSessionRead } from "./managed-image-session-read.js";
import { readImageThumbnailFromFile } from "./managed-image-thumbnail-cache.js";
import { handleManagedImageThumbnailResponse } from "./managed-image-thumbnail-response.js";
import {
  MANAGED_OUTGOING_ATTACHMENT_ID_RE,
  buildManagedOutgoingArtifactId,
  buildOutgoingVariantUrl,
  parseManagedOutgoingArtifactId,
} from "./managed-outgoing-artifact-id.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { prepareRemoteIngressSessionRead } from "./remote-ingress-session-read.js";
import type { GatewayClient } from "./server-methods/types.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import {
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesWithSourceAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";
import {
  iterateSessionTranscriptSourcePages,
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "./session-transcript-source-pages.js";
export {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX,
  parseManagedOutgoingArtifactId,
} from "./managed-outgoing-artifact-id.js";

const DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS = 15 * 60 * 1000;

export const DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 20_000_000,
} as const;

export type ManagedImageAttachmentLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
};

type ManagedImageAttachmentLimitsConfig = Partial<ManagedImageAttachmentLimits>;

type ParsedMediaDataUrl = {
  buffer: Buffer;
  contentType: string;
  mediaKind: ManagedMediaKind;
};

type ManagedMediaBlock = Record<string, unknown>;

export type PreparedOutgoingMedia = {
  url: string;
  filename?: string;
  mimeType?: string;
  trustedLocal: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
};

type SessionManagedOutgoingAttachmentIndex = {
  messageIds: Set<string>;
  matches?: Set<string> | null;
};
type ManagedOutgoingTranscriptMatch = "match" | "missing" | "unavailable";
type ManagedOutgoingAttachmentRef = { attachmentId: string; sessionKey: string };
const EMPTY_MANAGED_ATTACHMENT_REFS: readonly ManagedOutgoingAttachmentRef[] = [];

export type ManagedOutgoingMediaArtifactDownload = {
  artifactId: string;
  sessionKey: string;
  type: Exclude<ManagedMediaKind, "document"> | "file";
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  url: string;
};

function resolveManagedImageAttachmentLimits(
  config?: ManagedImageAttachmentLimitsConfig | null,
): ManagedImageAttachmentLimits {
  return {
    maxBytes: config?.maxBytes ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxBytes,
    maxWidth: config?.maxWidth ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxWidth,
    maxHeight: config?.maxHeight ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxHeight,
    maxPixels: config?.maxPixels ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxPixels,
  };
}

export function buildManagedMediaFailureBlock(params: {
  code: ReplyMediaFailureCode;
  kind: ManagedMediaKind | "media";
  label: string;
  mimeType?: string;
}): Record<string, unknown> {
  return {
    type: "attachment_error",
    attachment: {
      code: params.code,
      kind: params.kind === "media" ? "document" : params.kind,
      label: params.label,
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    },
  };
}

function assertManagedMediaByteLimit(
  size: number,
  kind: ManagedMediaKind,
  label: string,
  maxBytes: number,
): void {
  if (size > maxBytes) {
    throw createManagedImageAttachmentError(
      `Managed ${kind} attachment ${JSON.stringify(label)} exceeds the ${formatLimitMiB(maxBytes)} byte limit`,
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

function deriveAltText(source: string, index: number) {
  const fallback = `Generated image ${index + 1}`;
  try {
    if (hasHttpUrlPrefix(source)) {
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

function parseMediaDataUrl(
  source: string,
  label: string,
  imageLimits: ManagedImageAttachmentLimits,
): ParsedMediaDataUrl | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }

  const afterPrefix = trimmed.slice("data:".length);
  const commaIdx = afterPrefix.indexOf(",");
  const mimeAndParams = commaIdx < 0 ? "" : afterPrefix.slice(0, commaIdx);
  const base64Marker = ";base64";
  if (mimeAndParams.slice(-base64Marker.length).toLowerCase() !== base64Marker) {
    throw new Error("Invalid image data URL");
  }
  const semicolonIdx = mimeAndParams.indexOf(";");
  const contentType = (semicolonIdx < 0 ? mimeAndParams : mimeAndParams.slice(0, semicolonIdx))
    .trim()
    .toLowerCase();
  if (!contentType) {
    throw new Error("Invalid image data URL");
  }

  const base64Part = afterPrefix.slice(commaIdx + 1);
  // Quantified matches can exhaust the RegExp stack on large base64 payloads.
  if (!base64Part || /[^A-Za-z0-9+/=\s]/.test(base64Part)) {
    throw new Error("Invalid image data URL");
  }

  const mediaKind = mediaKindFromMime(contentType);
  if (mediaKind !== "image" && mediaKind !== "audio" && mediaKind !== "video") {
    throw new Error("Managed media attachment has an unsupported data URL content type");
  }

  const maxBytes = maxBytesForManagedMediaKind(mediaKind, imageLimits.maxBytes);
  const base64 = base64Part.replace(/\s+/g, "");
  const padding = Math.min(/=+$/u.exec(base64)?.[0].length ?? 0, 2);
  assertManagedMediaByteLimit(
    Math.floor((base64.length * 3) / 4) - padding,
    mediaKind,
    label,
    maxBytes,
  );

  return {
    buffer: Buffer.from(base64, "base64"),
    contentType,
    mediaKind,
  };
}

export async function cleanupManagedOutgoingMediaRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  agentId?: string;
  forceDeleteSessionRecords?: boolean;
  hasActiveSessionRun?: (sessionKey: string, agentId: string | undefined) => boolean;
}): Promise<void> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs = params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const agentIdFilter = params?.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const globalCompatibilityOwnerAgentId =
    sessionKeyFilter === "global" && agentIdFilter
      ? tryResolveSessionCompatibilityOwnerAgentId(getRuntimeConfig(), "global")
      : undefined;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const entries = await listManagedImageRecordEntries({ stateDir });
  let pendingPreparedAttachmentIds: Set<string> | null | undefined;

  const transcriptAttachmentIndexCache = new Map<string, SessionManagedOutgoingAttachmentIndex>();
  for (const { record } of entries) {
    if (!record.messageId) {
      continue;
    }
    const key = managedOutgoingAttachmentSessionKey(record);
    let index = transcriptAttachmentIndexCache.get(key);
    if (!index) {
      index = { messageIds: new Set() };
      transcriptAttachmentIndexCache.set(key, index);
    }
    index.messageIds.add(record.messageId);
  }
  for (const entry of entries) {
    const { record } = entry;
    if (sessionKeyFilter && record.sessionKey !== sessionKeyFilter) {
      continue;
    }
    if (
      sessionKeyFilter === "global" &&
      record.sessionKey === "global" &&
      (!agentIdFilter ||
        resolveManagedSessionOwnerAgentId(
          record.sessionKey,
          record.agentId,
          globalCompatibilityOwnerAgentId,
        ) !== agentIdFilter)
    ) {
      continue;
    }

    let shouldDelete = entry.cleanupPending;
    if (!entry.cleanupPending && forceDeleteSessionRecords) {
      shouldDelete = true;
    } else if (!entry.cleanupPending && record.messageId) {
      const transcriptMatch = await recordMatchesTranscriptMessage(
        record,
        transcriptAttachmentIndexCache.get(managedOutgoingAttachmentSessionKey(record))!,
        stateDir,
      );
      // Session-store unavailability is not proof that durable chat history no longer owns media.
      shouldDelete = transcriptMatch === "missing";
    } else if (!entry.cleanupPending) {
      const createdAtMs = Date.parse(record.createdAt);
      const otherwiseDeletable =
        Number.isFinite(createdAtMs) &&
        nowMs - createdAtMs >= transientMaxAgeMs &&
        params?.hasActiveSessionRun?.(record.sessionKey, record.agentId?.trim() || undefined) !==
          true;
      if (otherwiseDeletable) {
        if (pendingPreparedAttachmentIds === undefined) {
          pendingPreparedAttachmentIds = await loadPendingPreparedAttachmentIds(stateDir);
        }
        shouldDelete =
          pendingPreparedAttachmentIds !== null &&
          !pendingPreparedAttachmentIds.has(record.attachmentId);
      }
    }

    if (shouldDelete) {
      await deleteManagedImageRecordArtifacts(record, stateDir, entry.cleanupPending);
    }
  }

  await deleteAgedOrphanManagedImageFiles({
    stateDir,
    nowMs,
    minAgeMs: Math.max(transientMaxAgeMs, DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS),
  });
}

export async function removeManagedOutgoingMediaBlocks(
  params: {
    blocks: readonly Record<string, unknown>[];
    messageId: string | null;
    stateDir?: string;
  },
  context?: ReturnType<typeof captureManagedImageContext>,
): Promise<void> {
  const stateDir = params.stateDir ?? resolveStateDir();
  const messageId = params.messageId;
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (refs.length === 0) {
    return;
  }
  const captured = context ?? captureManagedImageContext(stateDir);
  await Promise.all(
    refs.map(async ({ attachmentId }) => {
      const record = await readManagedImageRecord(attachmentId, stateDir, captured);
      if (record?.messageId === messageId) {
        if (
          await captureChannelReadScope()?.discardResource(resolveManagedImageOriginalPath(record))
        ) {
          return;
        }
        await deleteManagedImageRecordArtifacts(record, stateDir, false, captured);
      }
    }),
  );
}

function resolveManagedSessionOwnerAgentId(
  sessionKey: string,
  explicitAgentId?: string,
  compatibilityAgentId?: string,
): string | undefined {
  const ownerAgentId =
    explicitAgentId?.trim() ||
    parseAgentSessionKey(sessionKey)?.agentId ||
    compatibilityAgentId?.trim();
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

function buildManagedMediaBlock(
  record: ManagedImageRecord,
  playback?: "native" | "transcode",
): ManagedMediaBlock {
  const kind = resolveManagedMediaKind(record.original.contentType);
  if (!kind) {
    throw new Error("Managed media record has an unsupported content type");
  }
  const fullUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  const artifactId = buildManagedOutgoingArtifactId(record.attachmentId, kind);
  if (kind === "document") {
    return {
      type: "attachment",
      attachment: {
        artifactId,
        url: fullUrl,
        kind,
        label: record.original.filename ?? record.alt,
        mimeType: record.original.contentType,
        sizeBytes: record.original.sizeBytes,
      },
    };
  }
  return {
    type: kind,
    artifactId,
    url: fullUrl,
    openUrl: fullUrl,
    ...(kind === "image" ? { alt: record.alt } : { fileName: record.original.filename }),
    mimeType: record.original.contentType,
    ...(playback ? { playback } : {}),
    ...(kind === "image" ? { width: record.original.width, height: record.original.height } : {}),
    sizeBytes: record.original.sizeBytes,
  };
}

function buildManagedOutgoingAttachmentRefKey(messageId: string, attachmentId: string) {
  return `${messageId}::${attachmentId}`;
}

function toRecordFilename(
  filePath: string,
  attachmentName?: string,
  fallbackName?: string,
  contentType?: string,
) {
  const fallback = fallbackName ?? path.basename(filePath).trim();
  if (!attachmentName?.trim()) {
    return fallback || null;
  }
  const safeName = sanitizeUntrustedFileName(attachmentName, fallback);
  const extension =
    contentType === "application/octet-stream" || mimeTypeFromFilePath(safeName) === contentType
      ? path.extname(safeName)
      : path.extname(filePath);
  return `${path.parse(safeName).name}${extension}`;
}

export function prepareOutgoingMediaFromReplyPayload(
  payload: ReplyPayload,
  metadataSource: ReplyPayload = payload,
): PreparedOutgoingMedia[] {
  const metadataByUrl = new Map<string, ReplyMediaAttachment>();
  for (const entry of collectReplyMediaEntries(metadataSource)) {
    const key = entry.url.trim();
    if (key && entry.attachment && !metadataByUrl.has(key)) {
      metadataByUrl.set(key, entry.attachment);
    }
  }
  const seen = new Set<string>();
  return collectReplyMediaEntries(payload).flatMap((entry) => {
    const key = entry.url.trim();
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    const attachment = metadataByUrl.get(key) ?? entry.attachment;
    return [
      {
        url: entry.url,
        ...(attachment?.name ? { filename: attachment.name } : {}),
        ...(attachment?.mimeType ? { mimeType: attachment.mimeType } : {}),
        trustedLocal: attachment?.trustedLocalMedia ?? payload.trustedLocalMedia === true,
        ...(attachment?.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
        ...(attachment?.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment?.height !== undefined ? { height: attachment.height } : {}),
      },
    ];
  });
}

export function parseManagedOutgoingRoute(value: string) {
  try {
    const parsed = new URL(value, "http://localhost");
    const match = parsed.pathname.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/);
    if (!match) {
      return null;
    }
    const [, encodedSessionKey, attachmentId] = match;
    if (
      !encodedSessionKey ||
      !attachmentId ||
      !MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId)
    ) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(encodedSessionKey),
      attachmentId,
    };
  } catch {
    return null;
  }
}

function collectManagedOutgoingAttachmentRefs(
  blocks: readonly Record<string, unknown>[] | undefined,
  expectedSessionKey?: string,
): readonly ManagedOutgoingAttachmentRef[] {
  if (!blocks) {
    return EMPTY_MANAGED_ATTACHMENT_REFS;
  }
  let refs: Map<string, ManagedOutgoingAttachmentRef> | undefined;
  for (const block of blocks) {
    const attachment =
      block?.type === "attachment" ? asOptionalRecord(block.attachment) : undefined;
    if (
      block?.type !== "image" &&
      block?.type !== "audio" &&
      block?.type !== "video" &&
      !attachment
    ) {
      continue;
    }
    for (const candidate of [block.url, block.openUrl, attachment?.url]) {
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
      (refs ??= new Map()).set(parsed.attachmentId, parsed);
    }
  }
  return refs ? [...refs.values()] : EMPTY_MANAGED_ATTACHMENT_REFS;
}

async function loadPendingPreparedAttachmentIds(stateDir: string): Promise<Set<string> | null> {
  try {
    const queueContext = captureOpenClawStateWorkerContext({
      env: resolveDeliveryQueueStateEnv(stateDir),
    });
    const attachmentIds = new Set<string>();
    for (const entry of await loadPendingSessionDeliveries(queueContext)) {
      if (entry.kind !== "agentTurn") {
        continue;
      }
      for (const blocks of Object.values(entry.preparedMediaBlocks ?? {})) {
        for (const ref of collectManagedOutgoingAttachmentRefs(blocks, entry.sessionKey)) {
          attachmentIds.add(ref.attachmentId);
        }
      }
    }
    return attachmentIds;
  } catch {
    // Queue ownership must be readable before transient artifacts can be reaped safely.
    return null;
  }
}

async function recordMatchesTranscriptMessage(
  record: ManagedImageRecord,
  index: SessionManagedOutgoingAttachmentIndex,
  stateDir: string,
): Promise<ManagedOutgoingTranscriptMatch> {
  if (!record.messageId) {
    return "missing";
  }
  const { sessionKey, agentId, messageId: requestedMessageId } = record;
  const refKey = buildManagedOutgoingAttachmentRefKey(requestedMessageId, record.attachmentId);
  if (index.matches !== undefined) {
    return index.matches === null ? "unavailable" : index.matches.has(refKey) ? "match" : "missing";
  }
  const cfg = getRuntimeConfig();
  const ownerAgentId =
    resolveManagedSessionOwnerAgentId(sessionKey, agentId) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (!ownerAgentId) {
    return "unavailable";
  }
  const result = await withManagedImageSessionRead<ManagedOutgoingTranscriptMatch>(
    {
      cfg,
      agentId: ownerAgentId,
      sessionKey,
      stateDir,
      assertCurrent: captureChannelReadScope()?.assertCurrent ?? (() => {}),
      unavailable: "unavailable",
    },
    async (scope, assertCurrent) => {
      const matches = await readManagedOutgoingAttachmentIndex(scope, index.messageIds);
      assertCurrent();
      index.matches = matches;
      return matches === null ? "unavailable" : matches.has(refKey) ? "match" : "missing";
    },
  );
  if (result === null) {
    index.matches = new Set();
  }
  return result ?? "missing";
}

function managedOutgoingAttachmentSessionKey(record: ManagedImageRecord): string {
  return record.sessionKey === "global" && record.agentId
    ? `agent:${record.agentId}:global`
    : record.sessionKey;
}

async function readManagedOutgoingAttachmentIndex(
  scope: SessionTranscriptReadScope,
  messageIds: Set<string>,
): Promise<Set<string> | null> {
  // Archive file stats cannot establish current SQLite visibility. Reuse membership
  // only within a cleanup pass; each new request must select canonical history again.
  // Cleanup also owns off-path branches because rewind/switch can expose them again;
  // serving stays limited to visible history.
  const index = new Set<string>();
  const requestedIds = [...messageIds];
  try {
    for (let start = 0; start < requestedIds.length; start += SOURCE_PAGE_MAX_MESSAGES) {
      const pages = iterateSessionTranscriptSourcePages(readSessionMessagesWithSourceAsync, scope, {
        allowResetArchiveFallback: true,
        includeOffPathMessages: true,
        messageIds: requestedIds.slice(start, start + SOURCE_PAGE_MAX_MESSAGES),
      });
      for await (const { messages } of pages) {
        for (const message of messages) {
          const messageId = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
          if (typeof messageId !== "string" || !messageIds.has(messageId)) {
            continue;
          }
          for (const ref of collectManagedOutgoingAttachmentRefs(
            readAssistantDisplayContent(message),
            scope.sessionKey,
          )) {
            index.add(buildManagedOutgoingAttachmentRefKey(messageId, ref.attachmentId));
          }
        }
      }
    }
  } catch (error) {
    if (extractErrorCode(error) !== "TRANSCRIPT_SOURCE_MESSAGE_TOO_LARGE") {
      throw error;
    }
    // An incomplete scan cannot prove any attachment in this session is unreferenced.
    createSubsystemLogger("media").warn(
      `Retaining managed outgoing media for a session whose transcript exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`,
    );
    return null;
  }

  return index;
}

async function resolveManagedOutgoingMediaArtifactDownloadForRecord(
  record: ManagedImageRecord,
  stateDir?: string,
): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  return withManagedOutgoingMediaRead(
    record,
    stateDir ?? resolveStateDir(),
    async (assertCurrent) => {
      const kind = resolveManagedMediaKind(record.original.contentType);
      if (!kind) {
        return null;
      }
      try {
        const stat = await fs.stat(resolveManagedImageOriginalPath(record));
        if (!stat.isFile()) {
          return null;
        }
      } catch {
        return null;
      }
      assertCurrent();
      return {
        artifactId: buildManagedOutgoingArtifactId(record.attachmentId, kind),
        sessionKey: record.sessionKey,
        type: kind === "document" ? "file" : kind,
        title: kind === "image" ? record.alt : (record.original.filename ?? record.alt),
        ...(record.original.contentType ? { mimeType: record.original.contentType } : {}),
        ...(record.original.sizeBytes != null ? { sizeBytes: record.original.sizeBytes } : {}),
        url: buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full"),
      };
    },
  );
}

async function withManagedOutgoingMediaRead<T>(
  record: ManagedImageRecord,
  stateDir: string,
  consume: (assertCurrent: () => void) => Promise<T>,
  assertCallerCurrent: () => void = captureChannelReadScope()?.assertCurrent ?? (() => {}),
): Promise<T | null> {
  assertCallerCurrent();
  if (!record.messageId) {
    return null;
  }
  const cfg = getRuntimeConfig();
  const agentId =
    resolveManagedSessionOwnerAgentId(record.sessionKey, record.agentId) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, record.sessionKey);
  if (!agentId) {
    return null;
  }
  return withManagedImageSessionRead(
    { cfg, agentId, sessionKey: record.sessionKey, stateDir, assertCurrent: assertCallerCurrent },
    async (scope, assertCurrent) => {
      const messages = await readSessionMessagesMatchingIdAsync(scope, record.messageId!);
      assertCurrent();
      const matches = messages.some((message) =>
        collectManagedOutgoingAttachmentRefs(
          readAssistantDisplayContent(message),
          record.sessionKey,
        ).some((ref) => ref.attachmentId === record.attachmentId),
      );
      return matches ? consume(assertCurrent) : null;
    },
  );
}

type ManagedOutgoingMediaArtifactRequest = {
  sessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
  artifactId: string;
  stateDir?: string;
};

async function resolveManagedOutgoingMediaArtifactRecord(
  params: ManagedOutgoingMediaArtifactRequest,
): Promise<ManagedImageRecord | null> {
  const { artifactId, sessionKey, agentId, defaultAgentId } = params;
  const stateDir = params.stateDir ?? resolveStateDir();
  const parsed = parseManagedOutgoingArtifactId(artifactId);
  if (!parsed) {
    return null;
  }
  const record = await readManagedImageRecord(parsed.attachmentId, stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    return null;
  }
  const requestedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  const recordAgentId = resolveManagedSessionOwnerAgentId(
    record.sessionKey,
    record.agentId,
    defaultAgentId,
  );
  if (requestedAgentId && recordAgentId !== requestedAgentId) {
    return null;
  }
  const kind = resolveManagedMediaKind(record.original.contentType);
  if (!kind || (parsed.family === "image") !== (kind === "image")) {
    return null;
  }
  return record;
}

/** Prepare a transcript-backed media source; the RPC owner grants the requesting reader access. */
export async function resolveManagedOutgoingMediaArtifactDownload(
  params: ManagedOutgoingMediaArtifactRequest,
): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const record = await resolveManagedOutgoingMediaArtifactRecord(params);
  return record
    ? resolveManagedOutgoingMediaArtifactDownloadForRecord(record, params.stateDir)
    : null;
}

/** Upgrade legacy managed-image URLs that predate stable artifact ids. */
export async function resolveManagedOutgoingMediaUrlDownload(params: {
  sessionKey: string;
  url: string;
}): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const { url, sessionKey } = params;
  const stateDir = resolveStateDir();
  const parsed = parseManagedOutgoingRoute(url);
  if (!parsed || parsed.sessionKey !== sessionKey) {
    return null;
  }
  const record = await readManagedImageRecord(parsed.attachmentId, stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    return null;
  }
  return await resolveManagedOutgoingMediaArtifactDownloadForRecord(record, stateDir);
}

/** Read a local preview through the same transcript ownership and thumbnail cache as HTTP. */
export async function readManagedOutgoingImageThumbnail(
  params: ManagedOutgoingMediaArtifactRequest & {
    maxBytes: number;
    signal: AbortSignal;
  },
): Promise<Buffer | null> {
  const { maxBytes, signal } = params;
  const stateDir = params.stateDir ?? resolveStateDir();
  signal.throwIfAborted();
  const record = await resolveManagedOutgoingMediaArtifactRecord({ ...params, stateDir });
  signal.throwIfAborted();
  if (!record || resolveManagedMediaKind(record.original.contentType) !== "image") {
    return null;
  }
  return await withManagedOutgoingMediaRead(
    record,
    stateDir,
    async (assertCurrent) => {
      const opened = await openLocalFileSafely({
        filePath: resolveManagedImageOriginalPath(record),
      });
      try {
        const thumbnail = await readImageThumbnailFromFile(opened, maxBytes);
        assertCurrent();
        signal.throwIfAborted();
        return thumbnail;
      } finally {
        await opened.handle.close();
      }
    },
    () => signal.throwIfAborted(),
  );
}

export function attachManagedOutgoingMediaToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
}): Promise<boolean> {
  const messageId = params.messageId.trim();
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (!messageId || refs.length === 0) {
    return Promise.resolve(false);
  }
  return attachManagedImageRecordsToMessage({
    attachments: refs,
    messageId,
    updatedAt: new Date().toISOString(),
    stateDir: params.stateDir,
  });
}

export async function createManagedOutgoingMediaBlocks(params: {
  sessionKey: string;
  agentId?: string;
  items?: readonly PreparedOutgoingMedia[] | null;
  stateDir?: string;
  messageId?: string | null;
  limits?: ManagedImageAttachmentLimitsConfig | null;
  localRoots?: readonly string[] | "any";
  continueOnPrepareError?: boolean;
  onPrepareError?: (error: Error) => void;
  /** Reports each complete source group, including warnings or a failure card. */
  onPrepared?: (item: PreparedOutgoingMedia, blocks: readonly ManagedMediaBlock[]) => void;
  assertCurrent?: () => void;
  abortSignal?: AbortSignal;
}): Promise<ManagedMediaBlock[]> {
  return await withChannelReadAuthority(params.assertCurrent, async () => {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
      return [];
    }
    const items = params.items ?? [];
    if (items.length === 0) {
      return [];
    }
    const stateDir = params.stateDir ?? resolveStateDir();
    const context = captureManagedImageContext(stateDir);
    const limits = resolveManagedImageAttachmentLimits(params.limits);
    const blocks: ManagedMediaBlock[] = [];
    const discardBlocks = () =>
      removeManagedOutgoingMediaBlocks(
        { blocks, messageId: params.messageId ?? null, stateDir },
        context,
      );
    let resolvedLocalRoots: readonly string[] | undefined;
    for (const [index, item] of items.entries()) {
      const groupStart = blocks.length;
      const mediaUrl = item.url;
      const trimmedMediaUrl = mediaUrl.trim();
      const dataUrlKind = /^data:(image|audio|video)\//iu.exec(trimmedMediaUrl)?.[1];
      const fallbackLabel = `Generated ${dataUrlKind ?? "media"} ${index + 1}`;
      const isDataUrl = trimmedMediaUrl.startsWith("data:");
      const localMediaPath = isDataUrl ? undefined : resolveLocalMediaPath(mediaUrl);
      const label = isDataUrl
        ? fallbackLabel
        : item.filename?.trim() || deriveAltText(localMediaPath ?? mediaUrl, index);
      const inferredKind = resolveManagedMediaKind(
        item.mimeType ?? mimeTypeFromFilePath(localMediaPath ?? mediaUrl),
      );
      const hintedKind =
        dataUrlKind === "image" || dataUrlKind === "audio" || dataUrlKind === "video"
          ? dataUrlKind
          : (inferredKind ?? "media");

      let savedOriginalPath: string | null = null;
      let insertedRecord: ManagedImageRecord | undefined;
      let failureCode: ReplyMediaFailureCode = "delivery-failed";
      try {
        params.assertCurrent?.();
        const parsedDataUrl = parseMediaDataUrl(mediaUrl, fallbackLabel, limits);
        if (
          localMediaPath &&
          (hintedKind === "audio" || hintedKind === "video") &&
          !item.trustedLocal
        ) {
          throw new Error("Local audio/video media requires an explicitly trusted reply payload");
        }
        let resizeWarning: ManagedMediaBlock | null = null;
        let savedOriginal = parsedDataUrl
          ? await saveMediaBuffer(
              parsedDataUrl.buffer,
              parsedDataUrl.contentType,
              "outgoing/originals",
              maxBytesForManagedMediaKind(parsedDataUrl.mediaKind, limits.maxBytes),
              `generated-${parsedDataUrl.mediaKind}-${index + 1}`,
            )
          : await (async () => {
              if (localMediaPath) {
                const localRoots = params.localRoots;
                const localMediaOptions =
                  localRoots === "any"
                    ? undefined
                    : {
                        resolveRoots: async () => {
                          resolvedLocalRoots ??= await resolveLocalMediaRoots(localRoots);
                          return resolvedLocalRoots;
                        },
                      };
                await assertLocalMediaAllowed(localMediaPath, localRoots, localMediaOptions);
              }
              // File URLs have already been normalized for display metadata and policy checks.
              // Pass that path to the store instead of treating URI syntax as a filename.
              const ingestSource = localMediaPath ?? mediaUrl;
              const maxBytes = Math.max(
                limits.maxBytes,
                localMediaPath && (inferredKind === "audio" || inferredKind === "video")
                  ? WEBCHAT_LOCAL_MEDIA_MAX_BYTES
                  : 0,
                maxBytesForKind("audio"),
                maxBytesForKind("video"),
                maxBytesForKind("document"),
                MEDIA_MAX_BYTES,
              );
              if (hasHttpUrlPrefix(ingestSource)) {
                const { saveRemoteMediaForStore } =
                  await import("../media/store.remote.runtime.js");
                return await saveRemoteMediaForStore({
                  source: ingestSource,
                  subdir: "outgoing/originals",
                  maxBytes,
                  abortSignal: params.abortSignal,
                });
              }
              return await saveMediaSource(ingestSource, undefined, "outgoing/originals", maxBytes);
            })();
        savedOriginalPath = savedOriginal.path;
        let savedOriginalContentType = savedOriginal.contentType ?? item.mimeType;
        if (!savedOriginalContentType) {
          throw new Error("Managed media attachment has no detectable content type");
        }
        const mediaKind = resolveManagedMediaKind(savedOriginalContentType);
        if (!mediaKind) {
          failureCode = "unsupported-format";
          throw new Error("Managed media attachment has an unsupported content type");
        }
        if (localMediaPath && mediaKind !== "image" && !item.trustedLocal) {
          throw new Error("Local audio/video media requires an explicitly trusted reply payload");
        }
        const maxBytes = maxBytesForManagedMediaKind(
          mediaKind,
          limits.maxBytes,
          Boolean(localMediaPath),
        );
        assertManagedMediaByteLimit(savedOriginal.size, mediaKind, label, maxBytes);

        let originalStats: { width: number | null; height: number | null; sizeBytes: number } = {
          width: null,
          height: null,
          sizeBytes: savedOriginal.size,
        };
        if (mediaKind === "image") {
          const originalBuffer = parsedDataUrl
            ? parsedDataUrl.buffer
            : (await readLocalFileSafely({ filePath: savedOriginal.path })).buffer;
          assertManagedMediaByteLimit(originalBuffer.byteLength, "image", label, limits.maxBytes);
          const metadata = await getImageMetadata(originalBuffer);
          originalStats = {
            width: metadata?.width ?? null,
            height: metadata?.height ?? null,
            sizeBytes: savedOriginal.size,
          };
          const metadataLimitError = getManagedImageMetadataLimitError(metadata, label, limits);
          if (metadataLimitError) {
            if (!metadata) {
              throw createManagedImageAttachmentError(metadataLimitError);
            }
            const resized = await createImageProcessor().encode(originalBuffer, {
              format: "auto",
              limits: {
                maxWidth: limits.maxWidth,
                maxHeight: limits.maxHeight,
                maxPixels: limits.maxPixels,
              },
              opaque: { format: "jpeg", quality: 92 },
              transparent: { format: "png", compressionLevel: 9 },
              transparency: "auto",
            });
            assertManagedMediaByteLimit(resized.data.byteLength, "image", label, limits.maxBytes);
            const replacement = await saveMediaBuffer(
              resized.data,
              resized.mimeType,
              "outgoing/originals",
              limits.maxBytes,
              toRecordFilename(savedOriginal.path) ?? `generated-image-${index + 1}`,
            );
            await unlinkIfExists(savedOriginal.path);
            savedOriginal = replacement;
            savedOriginalContentType = replacement.contentType ?? resized.mimeType;
            savedOriginalPath = savedOriginal.path;
            originalStats = {
              width: resized.width,
              height: resized.height,
              sizeBytes: replacement.size,
            };
            resizeWarning = {
              type: "text",
              text:
                `[Image warning] ${label} exceeded gateway dimension/pixel limits and was resized from ` +
                `${metadata.width}×${metadata.height} to ${resized.width}×${resized.height}.`,
            };
          }
        }

        const record: ManagedImageRecord = {
          attachmentId: randomUUID(),
          sessionKey,
          ...(sessionKey === "global" && params.agentId?.trim()
            ? { agentId: params.agentId.trim() }
            : {}),
          messageId: params.messageId ?? null,
          createdAt: new Date().toISOString(),
          retentionClass: params.messageId ? "history" : "transient",
          alt: label,
          original: {
            mediaRoot: path.dirname(path.dirname(path.dirname(path.resolve(savedOriginal.path)))),
            mediaId: savedOriginal.id,
            mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
            contentType: savedOriginalContentType,
            width: originalStats.width,
            height: originalStats.height,
            sizeBytes: originalStats.sizeBytes,
            filename: toRecordFilename(
              savedOriginal.path,
              item.filename,
              mediaKind === "image" ? undefined : label,
              savedOriginalContentType,
            ),
          },
        };
        let playback: "native" | "transcode" | undefined;
        if (mediaKind === "audio" || mediaKind === "video") {
          const opened = await openLocalFileSafely({ filePath: savedOriginal.path });
          await opened[Symbol.asyncDispose]();
          try {
            const metadata = await resolvePlaybackMetadataForSource({
              sourcePath: opened.realPath,
              sourceStat: {
                size: opened.stat.size,
                mtimeMs: opened.stat.mtimeMs,
                ctimeMs: opened.stat.ctimeMs,
                exactIdentity: opened.exactIdentity,
              },
              mimeType: savedOriginalContentType,
              kind: mediaKind,
              signal: params.abortSignal,
              assertCurrent: params.assertCurrent,
              admission: "immediate",
            });
            playback = metadata.playback;
          } catch (error) {
            if (!(error instanceof PlaybackInspectionBusyError)) {
              throw error;
            }
          }
        }
        const block = buildManagedMediaBlock(record, playback);
        await insertManagedImageRecordWithFile(record, savedOriginal.path, stateDir, context);
        insertedRecord = record;
        context.admission.assertCurrent();
        const durationMs = asNonNegativeFiniteNumber(item.durationMs);
        const width = asNonNegativeFiniteNumber(item.width);
        const height = asNonNegativeFiniteNumber(item.height);
        blocks.push({
          ...block,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(mediaKind === "video" && width !== undefined ? { width } : {}),
          ...(mediaKind === "video" && height !== undefined ? { height } : {}),
        });
        if (resizeWarning) {
          blocks.push(resizeWarning);
        }
      } catch (error) {
        if (savedOriginalPath) {
          if (captureChannelReadScope()) {
            await unlinkIfExists(savedOriginalPath);
          } else if (insertedRecord) {
            await deleteManagedImageRecordArtifacts(insertedRecord, stateDir, false, context);
          } else if (!hasSqliteWorkerOutcomeUnknown(error)) {
            await unlinkIfExists(savedOriginalPath);
          }
        }
        try {
          params.assertCurrent?.();
        } catch (authorityError) {
          await discardBlocks();
          throw authorityError;
        }
        const sanitizedError = getSanitizedManagedImageAttachmentError(error, label, hintedKind);
        if (params.continueOnPrepareError) {
          blocks.push(
            buildManagedMediaFailureBlock({
              code: failureCode,
              kind: hintedKind,
              label,
              mimeType: item.mimeType ?? mimeTypeFromFilePath(localMediaPath ?? mediaUrl),
            }),
          );
          params.onPrepareError?.(sanitizedError);
          params.onPrepared?.(item, blocks.slice(groupStart));
          continue;
        }
        await discardBlocks();
        throw sanitizedError;
      }
      params.onPrepared?.(item, blocks.slice(groupStart));
    }
    return blocks;
  });
}

function sendStatus(res: ServerResponse, statusCode: number, body: string) {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

export async function handleManagedOutgoingMediaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    basePath?: string;
    stateDir?: string;
    clients?: ReadonlySet<GatewayClient>;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const requestPath =
    opts.basePath && requestUrl.pathname.startsWith(`${opts.basePath}/`)
      ? requestUrl.pathname.slice(opts.basePath.length)
      : requestUrl.pathname;
  const match = requestPath.match(
    /^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/(full|thumbnail)$/,
  );
  if (!match) {
    return false;
  }

  const respondNotFound = () => {
    sendStatus(res, 404, "not found");
    return true;
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  const encodedSessionKey = match[1];
  const attachmentId = match[2];
  const variant = match[3];
  if (!encodedSessionKey || !attachmentId || (variant !== "full" && variant !== "thumbnail")) {
    return false;
  }
  if (!MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId)) {
    return respondNotFound();
  }
  let sessionKey: string;
  try {
    sessionKey = decodeURIComponent(encodedSessionKey);
  } catch {
    return respondNotFound();
  }
  const mediaTicket = requestUrl.searchParams.get("mediaTicket");
  const clients = opts.clients ?? new Set<GatewayClient>();
  const selected = mediaTicket ? resolveArtifactDownloadGrant(clients, mediaTicket) : undefined;
  const canonicalPath = buildOutgoingVariantUrl(sessionKey, attachmentId, "full");
  if (
    mediaTicket &&
    (!selected ||
      selected.grant.source.kind !== "managed" ||
      selected.grant.source.path !== canonicalPath)
  ) {
    return respondNotFound();
  }
  let retained: ReturnType<typeof retainArtifactDownloadStream> | undefined;
  const assertGrantCurrent = () => {
    if (!selected) {
      return;
    }
    const ingress = getRemoteControlUiIngressContext(req);
    assertRemoteControlUiIngressCurrent(ingress);
    if (
      ingress &&
      selected.client.internal?.remoteIngressPrincipal?.assertCurrent !==
        ingress.resolvePrincipal().assertCurrent
    ) {
      throw new Error("Managed media belongs to another ingress grant");
    }
    if (retained) {
      retained.assertCurrent();
    } else {
      assertArtifactDownloadGrantCurrent(clients, selected.client, selected.ticket, selected.grant);
    }
  };
  let assertRequestCurrent: (() => void) | undefined;
  if (!selected) {
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      ...opts,
      req,
      res,
    });
    if (!requestAuth) {
      return true;
    }
    assertRequestCurrent = requestAuth.assertCurrent;

    const requestedScopes = resolveSharedSecretHttpOperatorScopes(req, requestAuth);
    const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
    if (!scopeAuth.allowed) {
      sendMissingScopeForbidden(res, scopeAuth.missingScope);
      return true;
    }
    // The reusable shared-secret route remains for older Control UI clients.
    // Ticketed clients prove the exact transcript attachment instead of
    // forwarding an owner credential through another HTTP stack.
    if (!resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "owner access required",
        },
      });
      return true;
    }
  }
  const assertCallerCurrent = () => {
    if (res.writableEnded || res.destroyed) {
      throw new Error("Managed media request ended");
    }
    assertRequestCurrent?.();
    assertGrantCurrent();
  };
  const stateDir = opts.stateDir ?? resolveStateDir();
  try {
    assertCallerCurrent();
    using ingressRead = await prepareRemoteIngressSessionRead(
      getRemoteControlUiIngressContext(req)?.resolvePrincipal(),
      sessionKey,
    );
    const assertRequest = assertRequestCurrent;
    assertRequestCurrent = () => {
      assertRequest?.();
      ingressRead.assertCurrent();
    };
    const record = await readManagedImageRecord(attachmentId, stateDir);
    assertCallerCurrent();
    if (!record || record.sessionKey !== sessionKey) {
      return respondNotFound();
    }
    const handled = await withManagedOutgoingMediaRead(
      record,
      stateDir,
      async (assertCurrent) => {
        const mediaKind = resolveManagedMediaKind(record.original.contentType);
        if (!mediaKind) {
          return respondNotFound();
        }

        let opened: Awaited<ReturnType<typeof openLocalFileSafely>>;
        try {
          opened = await openLocalFileSafely({
            filePath: resolveManagedImageOriginalPath(record),
          });
        } catch {
          return respondNotFound();
        }
        const immutableCacheControl = selected
          ? "private, no-store"
          : "private, max-age=31536000, immutable";
        const writeMediaHeaders = (
          contentType: string,
          filename: string | null,
          cacheControl = immutableCacheControl,
        ) => {
          res.setHeader("content-type", contentType);
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("referrer-policy", "no-referrer");
          res.setHeader("cache-control", cacheControl);
          res.setHeader(
            "content-disposition",
            buildManagedMediaContentDisposition(filename, contentType),
          );
        };
        let byteStream = createGatewayByteStream(res, opened.handle, respondNotFound);
        try {
          let responseContentType = record.original.contentType || "application/octet-stream";
          let responseFilename = record.original.filename;
          if (variant === "thumbnail") {
            // A full-image ticket already authorizes these original bytes; the thumbnail
            // is a lower-fidelity representation of the same transcript attachment.
            const thumbnail =
              mediaKind === "image"
                ? await readImageThumbnailFromFile(
                    opened,
                    undefined,
                    normalizeChatImageRenditionWidth(requestUrl.searchParams.get("width")),
                  ).catch(() => null)
                : null;
            await byteStream.close();
            assertCurrent?.();
            if (!thumbnail) {
              respondNotFound();
              return true;
            }
            return handleManagedImageThumbnailResponse(req, res, {
              thumbnail,
              filename: responseFilename,
              cacheControl: immutableCacheControl,
            });
          }

          const isPlayback =
            requestUrl.searchParams.get("playback") === "1" &&
            (mediaKind === "audio" || mediaKind === "video");
          if (isPlayback) {
            const playback = await resolvePlaybackTranscode({
              sourcePath: opened.realPath,
              sourceStat: {
                size: opened.stat.size,
                mtimeMs: opened.stat.mtimeMs,
                ctimeMs: opened.stat.ctimeMs,
                exactIdentity: opened.exactIdentity,
              },
              mimeType: responseContentType,
              kind: mediaKind,
              signal: byteStream.signal,
              assertCurrent,
            });
            if (playback.kind === "preparing") {
              await byteStream.close();
              assertCurrent?.();
              sendJson(res, 202, { status: "preparing" });
              return true;
            }
            if (playback.kind === "transcoded") {
              const transcoded = await openLocalFileSafely({ filePath: playback.path }).catch(
                () => null,
              );
              if (transcoded) {
                await byteStream.close();
                opened = transcoded;
                byteStream = createGatewayByteStream(res, opened.handle, respondNotFound);
                responseContentType = playback.contentType;
                responseFilename = replacePlaybackFileExtension(
                  responseFilename ?? "generated-media",
                  playback.extension,
                );
              }
            }
          }

          const byteResponse = resolveByteResponse({
            file: opened.stat,
            // Playback can replace a failed rendition with a successful one at the same URL.
            validators: isPlayback ? undefined : createImmutableFileValidators(opened.stat),
            method: req.method,
            request: req,
          });
          if (selected) {
            retained = retainArtifactDownloadStream(
              clients,
              selected.client,
              selected.ticket,
              selected.grant,
            );
          }
          // Stream from the verified descriptor while retaining its session and reader authority.
          await byteStream.pipe(
            byteResponse,
            req.method,
            () => {
              assertCurrent?.();
              writeMediaHeaders(
                responseContentType,
                responseFilename,
                isPlayback && !selected ? "private, no-cache" : immutableCacheControl,
              );
              writeByteHeaders(res, byteResponse);
            },
            selected ? { assertCurrent } : undefined,
          );
        } catch (error) {
          await byteStream.close();
          if (!res.writableEnded && !res.destroyed) {
            throw error;
          }
        }
        return true;
      },
      assertCallerCurrent,
    );
    if (handled === null) {
      assertCallerCurrent();
      respondNotFound();
    }
  } catch (error) {
    if (selected && !res.headersSent) {
      respondNotFound();
    } else if (!res.writableEnded && !res.destroyed) {
      throw error;
    }
  } finally {
    retained?.release();
  }
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
