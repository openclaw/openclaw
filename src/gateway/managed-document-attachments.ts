/**
 * Managed outgoing document attachments — Bug #9 sibling of
 * {@link ./managed-image-attachments.ts}.
 *
 * Background: when an assistant produces a non-image MEDIA: reference such as
 * an Excel pricing analysis (.xlsx) or a Word doc, the chat surface needs a
 * stable, signed download URL with the right `Content-Type` and a
 * `Content-Disposition: attachment; filename="<original>"` so the browser
 * offers the file as a real download. The image module is image-only by
 * design (resize, jpeg conversion, pixel limits, inline disposition); shoving
 * documents through it risks regressing image handling.
 *
 * This sibling module mirrors the same shape — `createManagedOutgoingDocumentBlocks`,
 * `attachManagedOutgoingDocumentsToMessage`, `cleanupManagedOutgoingDocumentRecords`,
 * `handleManagedOutgoingDocumentHttpRequest` — but skips every image-specific
 * transform and uses its own route prefix and on-disk records dir. That keeps
 * the boundary easy to audit and keeps PR risk small.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { resolveStateDir } from "../config/paths.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { mediaKindFromMime, MAX_DOCUMENT_BYTES } from "../media/constants.js";
import { assertLocalMediaAllowed } from "../media/local-media-access.js";
import { isPassThroughRemoteMediaSource } from "../media/media-source-url.js";
import { saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { resolveUserPath } from "../utils.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { loadSessionEntry, readSessionMessagesAsync } from "./session-utils.js";

const OUTGOING_DOCUMENT_ROUTE_PREFIX = "/api/chat/media/outgoing-doc";
const DEFAULT_TRANSIENT_OUTGOING_DOCUMENT_TTL_MS = 15 * 60 * 1000;
const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

export const DEFAULT_MANAGED_DOCUMENT_ATTACHMENT_LIMITS = {
  // Cap an individual document at 25 MiB. Office files in the wild rarely
  // exceed this; 100 MiB (the global MAX_DOCUMENT_BYTES) is reserved for the
  // saveMediaSource ceiling.
  maxBytes: 25 * 1024 * 1024,
} as const;

export type ManagedDocumentAttachmentLimits = {
  maxBytes: number;
};

type ManagedDocumentAttachmentLimitsConfig = Partial<
  Pick<ManagedDocumentAttachmentLimits, "maxBytes">
>;

type ManagedDocumentRecordVariant = {
  path: string;
  contentType: string;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedDocumentRetentionClass = "transient" | "history";

type ManagedDocumentRecord = {
  attachmentId: string;
  sessionKey: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedDocumentRetentionClass;
  label: string;
  original: ManagedDocumentRecordVariant;
};

type ManagedDocumentBlock = Record<string, unknown>;

type CleanupManagedOutgoingDocumentRecordsResult = {
  deletedRecordCount: number;
  deletedFileCount: number;
  retainedCount: number;
};

type SessionManagedOutgoingAttachmentIndex = Set<string>;

type SessionManagedOutgoingAttachmentIndexCacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  index: SessionManagedOutgoingAttachmentIndex;
};

const sessionManagedOutgoingDocumentIndexCache = new Map<
  string,
  SessionManagedOutgoingAttachmentIndexCacheEntry
>();
const MAX_SESSION_MANAGED_OUTGOING_DOCUMENT_INDEX_CACHE_ENTRIES = 500;

export function resolveManagedDocumentAttachmentLimits(
  config?: ManagedDocumentAttachmentLimitsConfig | null,
): ManagedDocumentAttachmentLimits {
  return {
    maxBytes: config?.maxBytes ?? DEFAULT_MANAGED_DOCUMENT_ATTACHMENT_LIMITS.maxBytes,
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

function createManagedDocumentAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedDocumentAttachmentError";
  return error;
}

function isManagedDocumentAttachmentSafeError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "ManagedDocumentAttachmentError") {
    return true;
  }
  return error.message.startsWith("Managed document attachment ");
}

function getSanitizedManagedDocumentAttachmentError(error: unknown, label: string): Error {
  if (isManagedDocumentAttachmentSafeError(error)) {
    return error;
  }
  return createManagedDocumentAttachmentError(
    `Managed document attachment ${JSON.stringify(label)} could not be prepared`,
  );
}

function resolveOutgoingDocumentRecordsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing-docs", "records");
}

function resolveOutgoingDocumentOriginalsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing-docs", "originals");
}

function resolveOutgoingDocumentRecordPath(attachmentId: string, stateDir = resolveStateDir()) {
  return path.join(resolveOutgoingDocumentRecordsDir(stateDir), `${attachmentId}.json`);
}

function buildOutgoingDocumentVariantUrl(sessionKey: string, attachmentId: string) {
  return `${OUTGOING_DOCUMENT_ROUTE_PREFIX}/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
}

function resolveRequesterSessionKey(req: IncomingMessage) {
  const raw = req.headers["x-openclaw-requester-session-key"];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() || null;
  }
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

async function requesterOwnsManagedDocumentSession(params: {
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

function deriveLabel(source: string, index: number) {
  const fallback = `Generated document ${index + 1}`;
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

function resolveLocalMediaPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
    return path.resolve(trimmed);
  }
  return undefined;
}

function estimateBase64DecodedByteLength(base64: string): number {
  const normalized = base64.replace(/\s+/g, "");
  const paddingMatch = /=+$/u.exec(normalized);
  const padding = Math.min(paddingMatch?.[0].length ?? 0, 2);
  return Math.floor((normalized.length * 3) / 4) - padding;
}

type ParsedDocumentDataUrl =
  | { kind: "not-data-url" }
  | { kind: "non-document-data-url" }
  | { kind: "document-data-url"; buffer: Buffer; contentType: string };

function parseDocumentDataUrl(
  source: string,
  label: string,
  limits: ManagedDocumentAttachmentLimits,
): ParsedDocumentDataUrl {
  const trimmed = source.trim();
  if (!trimmed.startsWith("data:")) {
    return { kind: "not-data-url" };
  }
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) {
    throw createManagedDocumentAttachmentError(
      `Managed document attachment ${JSON.stringify(label)} has an invalid data URL`,
    );
  }
  const contentType = match[1]?.trim().toLowerCase() ?? "";
  if (mediaKindFromMime(contentType) !== "document") {
    return { kind: "non-document-data-url" };
  }
  if (estimateBase64DecodedByteLength(match[2]) > limits.maxBytes) {
    throw createManagedDocumentAttachmentError(
      `Managed document attachment ${JSON.stringify(label)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
    );
  }
  return {
    kind: "document-data-url",
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
    contentType,
  };
}

async function writeManagedDocumentRecord(
  record: ManagedDocumentRecord,
  stateDir = resolveStateDir(),
) {
  const recordPath = resolveOutgoingDocumentRecordPath(record.attachmentId, stateDir);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf-8");
}

async function deleteManagedDocumentRecordArtifacts(
  record: ManagedDocumentRecord,
  stateDir = resolveStateDir(),
) {
  const files = new Set<string>();
  if (record.original?.path) {
    files.add(record.original.path);
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
    await fs.rm(resolveOutgoingDocumentRecordPath(record.attachmentId, stateDir), { force: true });
  } catch {
    // Ignore cleanup races or already-missing records.
  }
  return deletedFileCount;
}

async function deleteOrphanManagedDocumentFiles(params: {
  stateDir: string;
  referencedPaths: ReadonlySet<string>;
}) {
  let deletedFileCount = 0;
  for (const dir of [resolveOutgoingDocumentOriginalsDir(params.stateDir)]) {
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

export async function cleanupManagedOutgoingDocumentRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  forceDeleteSessionRecords?: boolean;
}): Promise<CleanupManagedOutgoingDocumentRecordsResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs = params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_DOCUMENT_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const recordsDir = resolveOutgoingDocumentRecordsDir(stateDir);
  let names: string[] = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    names = [];
  }

  let deletedRecordCount = 0;
  let deletedFileCount = 0;
  let retainedCount = 0;
  const retainedReferencedPaths = new Set<string>();
  const transcriptAttachmentIndexCache = new Map<
    string,
    SessionManagedOutgoingAttachmentIndex | null
  >();
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const recordPath = path.join(recordsDir, name);
    let record: ManagedDocumentRecord;
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf-8")) as ManagedDocumentRecord;
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
      if (record.original?.path) {
        retainedReferencedPaths.add(record.original.path);
      }
      retainedCount += 1;
      continue;
    }

    let shouldDelete = false;
    if (
      forceDeleteSessionRecords &&
      (!sessionKeyFilter || record.sessionKey === sessionKeyFilter)
    ) {
      shouldDelete = true;
    } else if (record.messageId) {
      shouldDelete = !(await recordMatchesTranscriptMessage(
        record,
        transcriptAttachmentIndexCache,
      ));
    } else {
      const createdAtMs = Date.parse(record.createdAt);
      shouldDelete = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= transientMaxAgeMs;
    }

    if (shouldDelete) {
      deletedRecordCount += 1;
      deletedFileCount += await deleteManagedDocumentRecordArtifacts(record, stateDir);
    } else {
      if (record.original?.path) {
        retainedReferencedPaths.add(record.original.path);
      }
      retainedCount += 1;
    }
  }

  deletedFileCount += await deleteOrphanManagedDocumentFiles({
    stateDir,
    referencedPaths: retainedReferencedPaths,
  });

  return { deletedRecordCount, deletedFileCount, retainedCount };
}

async function readManagedDocumentRecord(
  attachmentId: string,
  stateDir = resolveStateDir(),
): Promise<ManagedDocumentRecord | null> {
  try {
    const raw = await fs.readFile(
      resolveOutgoingDocumentRecordPath(attachmentId, stateDir),
      "utf-8",
    );
    return JSON.parse(raw) as ManagedDocumentRecord;
  } catch {
    return null;
  }
}

function buildManagedDocumentBlock(record: ManagedDocumentRecord): ManagedDocumentBlock {
  const fullUrl = buildOutgoingDocumentVariantUrl(record.sessionKey, record.attachmentId);
  return {
    type: "attachment",
    attachment: {
      url: fullUrl,
      kind: "document" as const,
      label: record.label,
      mimeType: record.original.contentType,
    },
  };
}

function buildManagedOutgoingAttachmentRefKey(messageId: string, attachmentId: string) {
  return `${messageId}::${attachmentId}`;
}

function toRecordFilename(filePath: string) {
  const name = path.basename(filePath).trim();
  return name || null;
}

function asArray(value: string[] | undefined | null) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function parseManagedOutgoingDocumentRoute(value: string) {
  try {
    const parsed = new URL(value, "http://localhost");
    const match = parsed.pathname.match(
      /^\/api\/chat\/media\/outgoing-doc\/([^/]+)\/([^/]+)\/full$/,
    );
    if (!match) {
      return null;
    }
    if (!MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(match[2])) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(match[1]),
      attachmentId: match[2],
    };
  } catch {
    return null;
  }
}

function collectManagedOutgoingDocumentRefs(
  blocks: readonly Record<string, unknown>[] | undefined,
  expectedSessionKey?: string,
) {
  const refs = new Map<string, { attachmentId: string; sessionKey: string }>();
  for (const block of blocks ?? []) {
    if (block?.type !== "attachment") {
      continue;
    }
    const attachment = (block as { attachment?: unknown }).attachment;
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const url = (attachment as { url?: unknown }).url;
    if (typeof url !== "string") {
      continue;
    }
    const parsed = parseManagedOutgoingDocumentRoute(url);
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
  return [...refs.values()];
}

function getCachedSessionManagedOutgoingDocumentIndex(
  sessionKey: string,
  stat: { transcriptPath: string; mtimeMs: number; size: number },
) {
  const cached = sessionManagedOutgoingDocumentIndexCache.get(sessionKey);
  if (!cached) {
    return null;
  }
  if (
    cached.transcriptPath !== stat.transcriptPath ||
    cached.mtimeMs !== stat.mtimeMs ||
    cached.size !== stat.size
  ) {
    sessionManagedOutgoingDocumentIndexCache.delete(sessionKey);
    return null;
  }
  sessionManagedOutgoingDocumentIndexCache.delete(sessionKey);
  sessionManagedOutgoingDocumentIndexCache.set(sessionKey, cached);
  return cached.index;
}

function setCachedSessionManagedOutgoingDocumentIndex(
  sessionKey: string,
  stat: { transcriptPath: string; mtimeMs: number; size: number },
  index: SessionManagedOutgoingAttachmentIndex,
) {
  sessionManagedOutgoingDocumentIndexCache.set(sessionKey, {
    transcriptPath: stat.transcriptPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    index,
  });
  while (
    sessionManagedOutgoingDocumentIndexCache.size >
    MAX_SESSION_MANAGED_OUTGOING_DOCUMENT_INDEX_CACHE_ENTRIES
  ) {
    const oldestKey = sessionManagedOutgoingDocumentIndexCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionManagedOutgoingDocumentIndexCache.delete(oldestKey);
  }
}

async function getSessionManagedOutgoingDocumentIndex(
  sessionKey: string,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
) {
  if (cache?.has(sessionKey)) {
    return cache.get(sessionKey) ?? null;
  }
  const { storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    cache?.set(sessionKey, null);
    return null;
  }

  let transcriptStat: { transcriptPath: string; mtimeMs: number; size: number } | null = null;
  const transcriptPath = typeof entry?.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (transcriptPath) {
    try {
      const stat = await fs.stat(transcriptPath);
      transcriptStat = {
        transcriptPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      const cachedIndex = getCachedSessionManagedOutgoingDocumentIndex(sessionKey, transcriptStat);
      if (cachedIndex) {
        cache?.set(sessionKey, cachedIndex);
        return cachedIndex;
      }
    } catch {
      sessionManagedOutgoingDocumentIndexCache.delete(sessionKey);
    }
  }

  const messages = await readSessionMessagesAsync(sessionId, storePath, entry.sessionFile, {
    mode: "full",
    reason: "managed outgoing document index",
  });
  const index: SessionManagedOutgoingAttachmentIndex = new Set();
  for (const message of messages) {
    const meta = (message as { __openclaw?: { id?: string } } | null)?.__openclaw;
    const messageId = meta?.id;
    if (typeof messageId !== "string" || !messageId) {
      continue;
    }
    for (const ref of collectManagedOutgoingDocumentRefs(
      Array.isArray((message as { content?: unknown[] } | null)?.content)
        ? ((message as { content: unknown[] }).content as Record<string, unknown>[])
        : [],
      sessionKey,
    )) {
      index.add(buildManagedOutgoingAttachmentRefKey(messageId, ref.attachmentId));
    }
  }

  if (transcriptStat) {
    setCachedSessionManagedOutgoingDocumentIndex(sessionKey, transcriptStat, index);
  }
  cache?.set(sessionKey, index);
  return index;
}

async function recordMatchesTranscriptMessage(
  record: ManagedDocumentRecord,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
) {
  if (!record.messageId) {
    return false;
  }
  const index = await getSessionManagedOutgoingDocumentIndex(record.sessionKey, cache);
  return (
    index?.has(buildManagedOutgoingAttachmentRefKey(record.messageId, record.attachmentId)) ?? false
  );
}

export async function attachManagedOutgoingDocumentsToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
}) {
  const messageId = params.messageId.trim();
  if (!messageId) {
    return;
  }
  const refs = collectManagedOutgoingDocumentRefs(params.blocks);
  if (refs.length === 0) {
    return;
  }
  await Promise.all(
    refs.map(async ({ attachmentId, sessionKey }) => {
      const record = await readManagedDocumentRecord(attachmentId, params.stateDir);
      if (!record || record.sessionKey !== sessionKey) {
        return;
      }
      if (record.messageId === messageId && record.retentionClass === "history") {
        return;
      }
      await writeManagedDocumentRecord(
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

export async function createManagedOutgoingDocumentBlocks(params: {
  sessionKey: string;
  mediaUrls?: string[] | null;
  stateDir?: string;
  messageId?: string | null;
  limits?: ManagedDocumentAttachmentLimitsConfig | null;
  localRoots?: readonly string[] | "any";
  continueOnPrepareError?: boolean;
  onPrepareError?: (error: Error) => void;
}): Promise<ManagedDocumentBlock[]> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }
  const mediaUrls = asArray(params.mediaUrls);
  if (mediaUrls.length === 0) {
    return [];
  }
  const stateDir = params.stateDir ?? resolveStateDir();
  const limits = resolveManagedDocumentAttachmentLimits(params.limits);
  const blocks: ManagedDocumentBlock[] = [];
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const fallbackLabel = `Generated document ${index + 1}`;
    const parsedDataUrl = parseDocumentDataUrl(mediaUrl, fallbackLabel, limits);
    const label =
      parsedDataUrl.kind === "document-data-url" ? fallbackLabel : deriveLabel(mediaUrl, index);
    if (parsedDataUrl.kind === "non-document-data-url") {
      // Image/audio/video data URLs are owned by their respective managed
      // attachment modules; skip silently.
      continue;
    }

    let savedOriginalPath: string | null = null;
    try {
      let savedOriginal =
        parsedDataUrl.kind === "document-data-url"
          ? await saveMediaBuffer(
              parsedDataUrl.buffer,
              parsedDataUrl.contentType,
              "outgoing-docs/originals",
              limits.maxBytes,
              label,
            )
          : await (async () => {
              const localMediaPath = resolveLocalMediaPath(mediaUrl);
              if (localMediaPath) {
                await assertLocalMediaAllowed(localMediaPath, params.localRoots);
              }
              // Bound at the per-attachment doc limit and the global doc ceiling
              // so we never silently truncate large fetches.
              return await saveMediaSource(
                mediaUrl,
                undefined,
                "outgoing-docs/originals",
                Math.min(Math.max(limits.maxBytes, limits.maxBytes), MAX_DOCUMENT_BYTES),
              );
            })();
      savedOriginalPath = savedOriginal.path;
      const savedContentType = savedOriginal.contentType ?? "application/octet-stream";
      // Filter to document-kind MIMEs: images, audio, video flow through the
      // peer modules. Anything we can't classify falls through silently.
      if (mediaKindFromMime(savedContentType) !== "document") {
        await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
        savedOriginalPath = null;
        continue;
      }
      if (savedOriginal.size > limits.maxBytes) {
        throw createManagedDocumentAttachmentError(
          `Managed document attachment ${JSON.stringify(label)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }

      const stats = await fs.stat(savedOriginal.path).catch(() => null);
      const sizeBytes = stats && Number.isFinite(stats.size) ? stats.size : null;

      const record: ManagedDocumentRecord = {
        attachmentId: randomUUID(),
        sessionKey,
        messageId: params.messageId ?? null,
        createdAt: new Date().toISOString(),
        retentionClass: params.messageId ? "history" : "transient",
        label,
        original: {
          path: savedOriginal.path,
          contentType: savedContentType,
          sizeBytes,
          filename: toRecordFilename(savedOriginal.path) ?? label,
        },
      };
      await writeManagedDocumentRecord(record, stateDir);
      blocks.push(buildManagedDocumentBlock(record));
    } catch (error) {
      if (savedOriginalPath) {
        await fs.rm(savedOriginalPath, { force: true }).catch(() => {});
      }
      const sanitizedError = getSanitizedManagedDocumentAttachmentError(error, label);
      if (params.continueOnPrepareError) {
        params.onPrepareError?.(sanitizedError);
        continue;
      }
      throw sanitizedError;
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
  const fallback = "document";
  // Strip CR/LF, quotes, backslashes and path separators so the value is safe
  // to interpolate into a Content-Disposition header. Unicode is preserved so
  // sender filenames render correctly.
  const base = (value ?? fallback).replace(/[\r\n"\\/]/g, "_").trim();
  return base || fallback;
}

export async function handleManagedOutgoingDocumentHttpRequest(
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
    /^\/api\/chat\/media\/outgoing-doc\/([^/]+)\/([^/]+)\/full$/,
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
  if (!encodedSessionKey || !attachmentId) {
    return false;
  }
  if (!MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId)) {
    sendStatus(res, 404, "not found");
    return true;
  }
  let sessionKey: string;
  try {
    sessionKey = decodeURIComponent(encodedSessionKey);
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }
  const record = await readManagedDocumentRecord(attachmentId, opts.stateDir);
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
    const ownsSession = await requesterOwnsManagedDocumentSession({
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

  let body: Buffer;
  try {
    body = await fs.readFile(record.original.path);
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", record.original.contentType || "application/octet-stream");
  res.setHeader("content-length", String(body.byteLength));
  // Documents are downloads, not inline previews — that's the entire point of
  // this module. The image sibling uses `inline` because images render in the
  // chat surface; documents need Save As to land the file on disk.
  res.setHeader(
    "content-disposition",
    `attachment; filename="${safeAttachmentFilename(record.original.filename ?? record.label)}"`,
  );
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.end(body);
  return true;
}
