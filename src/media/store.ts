// Media store persists loaded media files and metadata for later references.
import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createAsyncLock, sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
import { fileStore } from "@openclaw/fs-safe/store";
import {
  basenameFromAnyPath,
  extnameFromAnyPath,
  nameFromAnyPath,
} from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  getFileExtension,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { FsSafeError, isPathInside, readLocalFileSafely } from "../infra/fs-safe.js";
import { retryAsync } from "../infra/retry.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import { resolveConfigDir } from "../utils.js";
import { MEDIA_FILE_MODE, SaveMediaSourceError } from "./store.shared.js";

/** Default per-file media-store byte cap used by store and plugin SDK callers. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const PLAYBACK_TRANSCODE_SUBDIR = "playback-transcode";

// The outgoing tree is owned by the SQLite managed-media reaper: originals
// there are referenced by durable chat-history records, and the legacy
// records/*.json files are the pre-SQLite migration barrier. An mtime-only
// sweep would delete both out from under that reaper.
const MANAGED_OUTGOING_SUBDIR = "outgoing";
const OUTBOUND_STAGING_SUBDIR = "outbound";
// Match delivery-queue orphan grace: staged files get a full day to reach
// every direct, streamed, fan-out, or queue-owned delivery path.
const OUTBOUND_STAGING_TTL_MS = 24 * 60 * 60_000;
/** Fixed disk budget for cached playback renditions; oldest outputs are evicted first. */
const PLAYBACK_TRANSCODE_MAX_CACHE_BYTES = 512 * 1024 * 1024;
/** Playback renditions outlive transient media but are still retired after one week. */
const PLAYBACK_TRANSCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
const queuePlaybackCacheOperation = createAsyncLock();
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};

function resolveMediaSubdir(subdir: string, caller: string): string {
  if (typeof subdir !== "string") {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  if (!subdir || subdir === ".") {
    return "";
  }
  if (
    subdir.includes("\0") ||
    path.isAbsolute(subdir) ||
    path.posix.isAbsolute(subdir) ||
    path.win32.isAbsolute(subdir)
  ) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  const segments = subdir.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  return path.posix.join(...segments);
}

function resolveMediaScopedDir(subdir: string, caller: string): string {
  const mediaDir = getMediaDir();
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  const dir = safeSubdir ? path.join(mediaDir, safeSubdir) : mediaDir;
  if (!isPathInside(mediaDir, dir)) {
    throw new Error(`${caller}: media subdir escapes media directory: ${JSON.stringify(subdir)}`);
  }
  return dir;
}

function resolveMediaRelativePath(id: string, subdir: string, caller: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`${caller}: unsafe media ID: ${JSON.stringify(id)}`);
  }
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  return safeSubdir ? path.posix.join(safeSubdir, id) : id;
}

function openMediaStore(maxBytes = MEDIA_MAX_BYTES, rootDir = getMediaDir()) {
  return fileStore({
    rootDir,
    dirMode: 0o700,
    maxBytes,
    mode: MEDIA_FILE_MODE,
  });
}

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  // Store keys require NFC; source filesystem paths keep their original spelling.
  // The nonempty fallback collapses to an empty prefix below for UUID-only keys.
  const base = sanitizeUntrustedFileName(name, "_").normalize("NFC");
  const sanitized = base.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return truncateUtf16Safe(sanitized.replace(/_+/g, "_").replace(/^_|_$/g, ""), 60);
}

/** Restores the caller-facing filename from media-store paths with embedded UUID suffixes. */
export function extractOriginalFilename(filePath: string): string {
  const basename = basenameFromAnyPath(filePath);
  if (!basename) {
    return "file.bin";
  }

  const ext = extnameFromAnyPath(basename);
  const nameWithoutExt = path.basename(basename, ext);

  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename;
}

/** Returns the configured absolute media-store root without creating it. */
export function getMediaDir() {
  return path.join(resolveConfigDir(), "media");
}

/** Creates the configured media-store root with private directory permissions. */
export async function ensureMediaDir() {
  const mediaDir = getMediaDir();
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  return mediaDir;
}

function findErrorWithCode(err: unknown, code: string): NodeJS.ErrnoException | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  if ("code" in err && err.code === code) {
    return err as NodeJS.ErrnoException;
  }
  return findErrorWithCode(err.cause, code);
}

function hasRecoverableMissingMediaDirCause(err: unknown): boolean {
  // Recursive mkdir repairs only the ENOENT race where cleanup pruned the directory.
  // Structural ENOTDIR and generic fs-safe absence remain terminal diagnostics.
  return findErrorWithCode(err, "ENOENT") !== undefined;
}

async function retryAfterRecreatingDir<T>(
  dir: string,
  run: () => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T> {
  return await retryAsync(
    async () => {
      try {
        return await run();
      } catch (err) {
        throw findErrorWithCode(err, "ENOSPC") ?? err;
      }
    },
    {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      shouldRetry: (err) => canRetry() && hasRecoverableMissingMediaDirCause(err),
      onRetry: async () => {
        // Cleanup can prune the directory between mkdir and file open. Recreate
        // it once; further failures remain terminal instead of looping.
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      },
    },
  );
}

async function prunePlaybackTranscodeCacheToSize(): Promise<void> {
  const dir = resolveMediaScopedDir(PLAYBACK_TRANSCODE_SUBDIR, "prunePlaybackTranscodeCacheToSize");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || entry.name.startsWith(".")) {
          return null;
        }
        const stat = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
        return stat?.isFile() ? { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      }),
    )
  )
    .filter((entry): entry is { name: string; size: number; mtimeMs: number } => Boolean(entry))
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  for (const file of files) {
    if (totalBytes <= PLAYBACK_TRANSCODE_MAX_CACHE_BYTES) {
      break;
    }
    const relativePath = resolveMediaRelativePath(
      file.name,
      PLAYBACK_TRANSCODE_SUBDIR,
      "prunePlaybackTranscodeCacheToSize",
    );
    const removed = await openMediaStore()
      .remove(relativePath)
      .then(() => true)
      .catch(() => false);
    if (removed) {
      totalBytes -= file.size;
    }
  }
}

async function pruneNonPlaybackMedia(ttlMs: number, options: CleanOldMediaOptions): Promise<void> {
  if (options.recursive === false) {
    await openMediaStore().pruneExpired({ ttlMs, recursive: false, maxDepth: 0 });
    return;
  }
  const mediaDir = getMediaDir();
  await openMediaStore().pruneExpired({ ttlMs, recursive: false, maxDepth: 0 });
  const entries = await fs.readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === PLAYBACK_TRANSCODE_SUBDIR ||
      entry.name === MANAGED_OUTGOING_SUBDIR
    ) {
      continue;
    }
    const scopedDir = path.join(mediaDir, entry.name);
    const recursive = options.recursive === true;
    await openMediaStore(MEDIA_MAX_BYTES, scopedDir).pruneExpired({
      ttlMs,
      recursive,
      maxDepth: recursive ? undefined : 0,
      pruneEmptyDirs: options.pruneEmptyDirs,
    });
    if (options.pruneEmptyDirs) {
      await fs.rmdir(scopedDir).catch(() => {});
    }
  }
}

/** Serializes cache publication with quota enforcement and propagates failures to the writer. */
export async function writePlaybackTranscodeCache(params: {
  buffer: Buffer;
  fileName: string;
  maxBytes: number;
  tempPrefix: string;
}): Promise<string> {
  return await queuePlaybackCacheOperation(async () => {
    const relativePath = resolveMediaRelativePath(
      params.fileName,
      PLAYBACK_TRANSCODE_SUBDIR,
      "writePlaybackTranscodeCache",
    );
    const filePath = await openMediaStore(params.maxBytes).write(relativePath, params.buffer, {
      maxBytes: params.maxBytes,
      tempPrefix: params.tempPrefix,
    });
    await prunePlaybackTranscodeCacheToSize();
    return filePath;
  });
}

/** Prunes expired playback renditions and reapplies the fixed cache size budget. */
export async function prunePlaybackTranscodeCache(): Promise<void> {
  await queuePlaybackCacheOperation(async () => {
    const cacheDir = resolveMediaScopedDir(
      PLAYBACK_TRANSCODE_SUBDIR,
      "prunePlaybackTranscodeCache",
    );
    await openMediaStore(MEDIA_MAX_BYTES, cacheDir).pruneExpired({
      ttlMs: PLAYBACK_TRANSCODE_TTL_MS,
      recursive: true,
      pruneEmptyDirs: true,
    });
    await prunePlaybackTranscodeCacheToSize();
  });
}

/** Prunes stale delivery staging without touching inbound replay or SQLite-owned outgoing media. */
export async function pruneOutboundMedia(): Promise<void> {
  const outboundDir = resolveMediaScopedDir(OUTBOUND_STAGING_SUBDIR, "pruneOutboundMedia");
  await openMediaStore(MEDIA_MAX_BYTES, outboundDir).pruneExpired({
    ttlMs: OUTBOUND_STAGING_TTL_MS,
    recursive: true,
    pruneEmptyDirs: true,
  });
  const { pruneStaleTrustedGeneratedHtmlMarkers } = await import("./web-media.js");
  await pruneStaleTrustedGeneratedHtmlMarkers();
}

/** Prunes expired non-playback media, optionally recursing into scoped subdirectories. */
export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  await pruneNonPlaybackMedia(ttlMs, options);
  // Trust metadata must not outlive the staged file that it authorizes.
  const { pruneStaleTrustedGeneratedHtmlMarkers } = await import("./web-media.js");
  await pruneStaleTrustedGeneratedHtmlMarkers();
}

/** Media-store file metadata returned after bytes are persisted under a safe media ID. */
export type SavedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};

function buildSavedMediaId(params: {
  baseId: string;
  ext: string;
  originalFilename?: string;
}): string {
  if (!params.originalFilename) {
    return params.ext ? `${params.baseId}${params.ext}` : params.baseId;
  }

  const base = nameFromAnyPath(params.originalFilename);
  const sanitized = sanitizeFilename(base);
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = extnameFromAnyPath(originalFilename);
  return /^\.[a-z0-9]{1,16}$/i.test(ext) ? ext : undefined;
}

function extensionForAuthoritativeHeaderMime(contentType?: string): string | undefined {
  const mime = normalizeMimeType(contentType);
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return undefined;
  }
  if (mime === "application/zip") {
    return undefined;
  }
  return extensionForMime(mime);
}

function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
}

function isImageHeaderMime(contentType?: string): boolean {
  return normalizeMimeType(contentType)?.startsWith("image/") === true;
}

function resolveSavedMediaExtension(params: {
  detectedMime?: string;
  headerExt?: string;
  contentType?: string;
  originalFilename?: string;
  detectionFilePathHint?: string;
}): string {
  const trustedHeaderExt =
    params.headerExt &&
    isGenericContainerMime(params.detectedMime) &&
    isImageHeaderMime(params.contentType)
      ? undefined
      : params.headerExt;
  return (
    trustedHeaderExt ??
    extensionForMime(params.detectedMime) ??
    safeOriginalFilenameExtension(params.originalFilename) ??
    getFileExtension(params.detectionFilePathHint) ??
    ""
  );
}

async function writeSavedMediaBuffer(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const readScope = captureChannelReadScope();
  readScope?.assertCurrent();
  const dir = resolveMediaScopedDir(params.subdir, "writeSavedMediaBuffer");
  const relativePath = resolveMediaRelativePath(params.id, params.subdir, "writeSavedMediaBuffer");
  return await retryAfterRecreatingDir(dir, async () => {
    if (readScope) {
      const { writeReadScopeMedia } = await import("./store.read-scope.js");
      await writeReadScopeMedia({
        dir,
        tempPrefix: `.${params.id}`,
        scope: readScope,
        durable: true,
        write: async (handle) => {
          readScope.assertCurrent();
          await handle.writeFile(params.buffer);
          return { id: params.id };
        },
      });
      return path.join(dir, params.id);
    }
    return await openMediaStore(params.buffer.byteLength).write(relativePath, params.buffer, {
      tempPrefix: `.${params.id}`,
    });
  });
}

async function writeMediaStreamToFile(params: {
  stream: AsyncIterable<unknown>;
  handle: FileHandle;
  maxBytes: number;
  assertCurrent?: () => void;
}): Promise<{ sniffBuffer: Buffer; size: number }> {
  const sniffBuffer = Buffer.allocUnsafe(16384);
  let sniffLen = 0;
  let total = 0;
  for await (const chunk of params.stream) {
    params.assertCurrent?.();
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof ArrayBuffer
          ? Buffer.from(chunk)
          : ArrayBuffer.isView(chunk)
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : undefined;
    if (!buffer) {
      throw new TypeError(`Unsupported media stream chunk: ${typeof chunk}`);
    }
    if (buffer.byteLength === 0) {
      continue;
    }
    total += buffer.byteLength;
    if (total > params.maxBytes) {
      throw SaveMediaSourceError.tooLarge(params.maxBytes);
    }
    if (sniffLen < sniffBuffer.length) {
      // The next pull may reuse the chunk; retain only the prefix we own.
      sniffLen += buffer.copy(sniffBuffer, sniffLen);
    }
    await params.handle.writeFile(buffer);
  }
  params.assertCurrent?.();
  return {
    sniffBuffer: sniffBuffer.subarray(0, sniffLen),
    size: total,
  };
}

function toSaveMediaSourceError(
  err: FsSafeError,
  maxBytes = MEDIA_MAX_BYTES,
): SaveMediaSourceError {
  switch (err.code) {
    case "symlink":
      return new SaveMediaSourceError("invalid-path", "Media path must not be a symlink", {
        cause: err,
      });
    case "not-file":
      return new SaveMediaSourceError("not-file", "Media path is not a file", { cause: err });
    case "path-mismatch":
      return new SaveMediaSourceError("path-mismatch", "Media path changed during read", {
        cause: err,
      });
    case "too-large":
      return SaveMediaSourceError.tooLarge(maxBytes, { cause: err });
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

/** Saves a local path or HTTP(S) source into the media store after MIME/size validation. */
export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MEDIA_MAX_BYTES,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaSource");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (hasHttpUrlPrefix(source)) {
    const { saveRemoteMediaForStore } = await import("./store.remote.runtime.js");
    return await saveRemoteMediaForStore({
      source,
      headers,
      subdir,
      maxBytes,
    });
  }
  const baseId = crypto.randomUUID();
  try {
    let buffer: Buffer;
    if (captureChannelReadScope()) {
      const { readLocalMediaFile } = await import("./local-media-access.js");
      buffer = await readLocalMediaFile(source, "any", { maxBytes });
    } else {
      buffer = (await readLocalFileSafely({ filePath: source, maxBytes })).buffer;
    }
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    await writeSavedMediaBuffer({ subdir, id, buffer });
    return { id, path: path.join(dir, id), size: buffer.byteLength, contentType: mime };
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw toSaveMediaSourceError(err, maxBytes);
    }
    throw err;
  }
}

/** Saves an in-memory media buffer under a UUID-backed media ID. */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MEDIA_MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw SaveMediaSourceError.tooLarge(maxBytes);
  }
  const dir = resolveMediaScopedDir(subdir, "saveMediaBuffer");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  const mime = await detectMime({
    buffer,
    headerMime: contentType,
    filePath: originalFilename ?? detectionFilePathHint,
  });
  const ext = resolveSavedMediaExtension({
    detectedMime: mime,
    headerExt,
    contentType,
    originalFilename,
    detectionFilePathHint,
  });
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  await writeSavedMediaBuffer({ subdir, id, buffer });
  return { id, path: path.join(dir, id), size: buffer.byteLength, contentType: mime };
}

/** Streams media into a sibling temp file before atomically publishing the final media ID. */
export async function saveMediaStream(
  stream: AsyncIterable<unknown>,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MEDIA_MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
): Promise<SavedMedia> {
  const readScope = captureChannelReadScope();
  readScope?.assertCurrent();
  const dir = resolveMediaScopedDir(subdir, "saveMediaStream");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const baseId = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  // Directory setup may retry before iteration starts. A consumed stream cannot
  // be replayed after a write or publication failure.
  let consumptionStarted = false;
  const mediaStream = (async function* () {
    consumptionStarted = true;
    yield* stream;
  })();
  const write = async (handle: FileHandle): Promise<Omit<SavedMedia, "path">> => {
    readScope?.assertCurrent();
    const { sniffBuffer, size } = await writeMediaStreamToFile({
      stream: mediaStream,
      handle,
      maxBytes,
      assertCurrent: readScope?.assertCurrent,
    });
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime: contentType,
      filePath: originalFilename ?? detectionFilePathHint,
    });
    const ext = resolveSavedMediaExtension({
      detectedMime: mime,
      headerExt,
      contentType,
      originalFilename,
      detectionFilePathHint,
    });
    const id = buildSavedMediaId({ baseId, ext, originalFilename });
    return { id, size, contentType: mime };
  };
  const result = await retryAfterRecreatingDir(
    dir,
    async () => {
      if (readScope) {
        const { writeReadScopeMedia } = await import("./store.read-scope.js");
        return await writeReadScopeMedia({
          dir,
          tempPrefix: `.${baseId}`,
          scope: readScope,
          write,
        });
      }
      const saved = await writeSiblingTempFile({
        dir,
        mode: MEDIA_FILE_MODE,
        tempPrefix: `.${baseId}`,
        writeTemp: async (tempPath) => {
          const handle = await fs.open(tempPath, "wx", MEDIA_FILE_MODE);
          try {
            return await write(handle);
          } finally {
            await handle.close().catch(() => undefined);
          }
        },
        resolveFinalPath: (resultLocal) => path.join(dir, resultLocal.id),
      });
      return saved.result;
    },
    () => !consumptionStarted,
  );
  return {
    id: result.id,
    path: path.join(dir, result.id),
    size: result.size,
    contentType: result.contentType,
  };
}

/**
 * Returns a validated store path for channels that require local attachments.
 * Prefer readMediaBuffer when the caller needs bytes bound to the opened file.
 */
export async function resolveMediaBufferPath(id: string, subdir = "inbound"): Promise<string> {
  const relativePath = resolveMediaRelativePath(id, subdir, "resolveMediaBufferPath");
  await using opened = await openMediaStore()
    .open(relativePath)
    .catch(() => null);
  if (!opened?.stat.isFile()) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }
  return opened.realPath;
}

/** Read result for callers that need media bytes plus the resolved file path. */
type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};

/** Reads a stored media ID with the same path guards and byte limit used by writers. */
export async function readMediaBuffer(
  id: string,
  subdir = "inbound",
  maxBytes = MEDIA_MAX_BYTES,
): Promise<ReadMediaBufferResult> {
  const relativePath = resolveMediaRelativePath(id, subdir, "readMediaBuffer");
  await using opened = await openMediaStore(maxBytes)
    .open(relativePath)
    .catch(() => null);
  if (!opened?.stat.isFile()) {
    throw new Error(`readMediaBuffer: media ID does not resolve to a file: ${JSON.stringify(id)}`);
  }
  if (opened.stat.size > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} is ${opened.stat.size} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  const buffer = await opened.handle.readFile();
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} read ${buffer.byteLength} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  return { id, path: opened.realPath, buffer, size: buffer.byteLength };
}

/**
 * Deletes a stored attachment through the pinned media root.
 * Errors propagate so the caller owns best-effort cleanup policy.
 */
export async function deleteMediaBuffer(id: string, subdir = "inbound"): Promise<void> {
  const relativePath = resolveMediaRelativePath(id, subdir, "deleteMediaBuffer");
  await openMediaStore().remove(relativePath);
}
