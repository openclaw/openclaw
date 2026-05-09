import "../infra/fs-safe-defaults.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveConfigDir } from "../utils.js";
import { detectMime, extensionForMime } from "./mime.js";
import { isFsSafeError, readLocalFileSafely, type FsSafeLikeError } from "./store.runtime.js";

const resolveMediaDir = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(resolveConfigDir(env), "media");
const resolveMediaMaterializationRoot = () => path.join(resolvePreferredOpenClawTmpDir(), "media");
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
// Temp materializations are intentionally readable by non-owner UIDs so Docker sandbox containers
// can access inbound media. SQLite remains the canonical store.
const MEDIA_FILE_MODE = 0o644;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};
type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;
type MediaKyselyDatabase = Pick<OpenClawStateKyselyDatabase, "media_blobs">;
type MediaBlobRow = {
  id: string;
  subdir: string;
  content_type: string | null;
  size_bytes: number;
  blob: Buffer;
  created_at: number;
  updated_at: number;
};
const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;
const defaultResolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = resolvePinnedHostname;

function formatMediaLimitMb(maxBytes: number): string {
  return `${(maxBytes / (1024 * 1024)).toFixed(0)}MB`;
}

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
  return path.join(...segments);
}

function resolveMediaScopedDir(subdir: string, caller: string): string {
  const mediaDir = resolveMediaMaterializationRoot();
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  const dir = safeSubdir ? path.join(mediaDir, safeSubdir) : mediaDir;
  return dir;
}

function resolveMediaRelativePath(id: string, subdir: string, caller: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`${caller}: unsafe media ID: ${JSON.stringify(id)}`);
  }
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  return safeSubdir ? path.join(safeSubdir, id) : id;
}

let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;
let resolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = defaultResolvePinnedHostnameImpl;

function getMediaKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<MediaKyselyDatabase>(db);
}

function mediaBlobRowFromDb(row: Selectable<MediaKyselyDatabase["media_blobs"]>): MediaBlobRow {
  return {
    ...row,
    blob: Buffer.from(row.blob),
  };
}

function getMediaBlobRow(params: { subdir: string; id: string }): MediaBlobRow | undefined {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getMediaKysely(database.db)
      .selectFrom("media_blobs")
      .selectAll()
      .where("subdir", "=", params.subdir)
      .where("id", "=", params.id),
  );
  return row ? mediaBlobRowFromDb(row) : undefined;
}

function upsertMediaBlob(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
  contentType?: string;
}): void {
  const now = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const row: Insertable<MediaKyselyDatabase["media_blobs"]> = {
      subdir: params.subdir,
      id: params.id,
      content_type: params.contentType ?? null,
      size_bytes: params.buffer.byteLength,
      blob: params.buffer,
      created_at: now,
      updated_at: now,
    };
    executeSqliteQuerySync(
      database.db,
      getMediaKysely(database.db)
        .insertInto("media_blobs")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["subdir", "id"]).doUpdateSet({
            content_type: (eb) => eb.ref("excluded.content_type"),
            size_bytes: (eb) => eb.ref("excluded.size_bytes"),
            blob: (eb) => eb.ref("excluded.blob"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  });
}

export function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void {
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
  resolvePinnedHostnameImpl = deps?.resolvePinnedHostname ?? defaultResolvePinnedHostnameImpl;
}

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  const base = sanitizeUntrustedFileName(name, "");
  if (!base) {
    return "";
  }
  const sanitized = base.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // Collapse multiple underscores, trim leading/trailing, limit length
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename) {
    return "file.bin";
  } // Fallback for empty input

  const ext = path.extname(basename);
  const nameWithoutExt = path.basename(basename, ext);

  // Check for ---{uuid} pattern (36 chars: 8-4-4-4-12 with hyphens)
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename; // Fallback: use as-is
}

export function getMediaDir() {
  return resolveMediaDir();
}

export function getMediaMaterializationDir() {
  return resolveMediaMaterializationRoot();
}

export async function ensureMediaDir() {
  const mediaDir = resolveMediaMaterializationRoot();
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

function isMissingPathError(err: unknown): boolean {
  return findErrorWithCode(err, "ENOENT") !== undefined;
}

async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const noSpaceError = findErrorWithCode(err, "ENOSPC");
    if (noSpaceError) {
      throw noSpaceError;
    }
    if (!isMissingPathError(err)) {
      throw err;
    }
    // Recursive cleanup can prune an empty directory between mkdir and the later
    // file open/write. Recreate once and retry the media write path.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run();
  }
}

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  const cutoff = Date.now() - ttlMs;
  runOpenClawStateWriteTransaction((database) => {
    const query = getMediaKysely(database.db)
      .deleteFrom("media_blobs")
      .where("created_at", "<", cutoff);
    executeSqliteQuerySync(
      database.db,
      options.recursive === false ? query.where("subdir", "not like", `%${path.sep}%`) : query,
    );
  });
  if (options.pruneEmptyDirs || options.recursive !== false) {
    await fs
      .rm(resolveMediaMaterializationRoot(), { recursive: true, force: true })
      .catch(() => {});
  }
}

function looksLikeUrl(src: string) {
  return /^https?:\/\//i.test(src);
}

/**
 * Download media into memory while capturing the first few KB for mime sniffing.
 */
async function downloadToBuffer(
  url: string,
  headers?: Record<string, string>,
  maxRedirects = 5,
  maxBytes = MAX_BYTES,
): Promise<{ headerMime?: string; sniffBuffer: Buffer; buffer: Buffer; size: number }> {
  return await new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
      return;
    }
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
    resolvePinnedHostnameImpl(parsedUrl.hostname)
      .then((pinned) => {
        const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location;
            if (!location || maxRedirects <= 0) {
              reject(new Error(`Redirect loop or missing Location header`));
              return;
            }
            const redirectUrl = new URL(location, url).href;
            const redirectHeaders =
              new URL(redirectUrl).origin === parsedUrl.origin
                ? headers
                : retainSafeHeadersForCrossOriginRedirect(headers);
            resolve(downloadToBuffer(redirectUrl, redirectHeaders, maxRedirects - 1, maxBytes));
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
            return;
          }
          let total = 0;
          const chunks: Buffer[] = [];
          const sniffChunks: Buffer[] = [];
          let sniffLen = 0;
          res.on("data", (chunk) => {
            total += chunk.length;
            chunks.push(chunk);
            if (sniffLen < 16384) {
              sniffChunks.push(chunk);
              sniffLen += chunk.length;
            }
            if (total > maxBytes) {
              req.destroy(new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`));
            }
          });
          res.on("end", () => {
            try {
              const sniffBuffer = Buffer.concat(sniffChunks, Math.min(sniffLen, 16384));
              const rawHeader = res.headers["content-type"];
              const headerMime = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
              const buffer = Buffer.concat(chunks, total);
              resolve({
                headerMime,
                sniffBuffer,
                buffer,
                size: total,
              });
            } catch (err) {
              reject(err);
            }
          });
        });
        req.on("error", reject);
        req.end();
      })
      .catch(reject);
  });
}

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

  const base = path.parse(params.originalFilename).name;
  const sanitized = sanitizeFilename(base);
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = path.extname(originalFilename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

function buildSavedMediaResult(params: {
  dir: string;
  id: string;
  size: number;
  contentType?: string;
  path?: string;
}): SavedMedia {
  return {
    id: params.id,
    path: params.path ?? path.join(params.dir, params.id),
    size: params.size,
    contentType: params.contentType,
  };
}

export async function saveMediaBufferWithId(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<string> {
  const safeSubdir = resolveMediaSubdir(params.subdir, "saveMediaBufferWithId");
  resolveMediaRelativePath(params.id, params.subdir, "saveMediaBufferWithId");
  upsertMediaBlob({
    subdir: safeSubdir,
    id: params.id,
    buffer: params.buffer,
    contentType: params.contentType,
  });
  return await materializeMediaBufferPath({
    subdir: safeSubdir,
    id: params.id,
    buffer: params.buffer,
  });
}

async function materializeMediaBufferPath(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const dir = resolveMediaScopedDir(params.subdir, "materializeMediaBufferPath");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const written = await writeSiblingTempFile({
    dir,
    mode: MEDIA_FILE_MODE,
    tempPrefix: `.${params.id}`,
    writeTemp: async (tempPath) => {
      await fs.writeFile(tempPath, params.buffer, { mode: MEDIA_FILE_MODE });
      return undefined;
    },
    resolveFinalPath: () => path.join(dir, params.id),
  });
  return written.filePath;
}

export type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

export class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }
}

function toSaveMediaSourceError(err: FsSafeLikeError, maxBytes = MAX_BYTES): SaveMediaSourceError {
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
      return new SaveMediaSourceError(
        "too-large",
        `Media exceeds ${formatMediaLimitMb(maxBytes)} limit`,
        { cause: err },
      );
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    case "invalid-path":
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MAX_BYTES,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaSource");
  await cleanOldMedia(DEFAULT_TTL_MS, { recursive: false });
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    const { headerMime, sniffBuffer, buffer, size } = await downloadToBuffer(
      source,
      headers,
      5,
      maxBytes,
    );
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
    const id = buildSavedMediaId({ baseId, ext });
    const materializedPath = await retryAfterRecreatingDir(dir, () =>
      saveMediaBufferWithId({ subdir, id, buffer, contentType: mime }),
    );
    return buildSavedMediaResult({
      dir,
      id,
      size,
      contentType: mime,
      path: materializedPath,
    });
  }
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    const materializedPath = await saveMediaBufferWithId({ subdir, id, buffer, contentType: mime });
    return buildSavedMediaResult({
      dir,
      id,
      size: stat.size,
      contentType: mime,
      path: materializedPath,
    });
  } catch (err) {
    if (isFsSafeError(err)) {
      throw toSaveMediaSourceError(err, maxBytes);
    }
    throw err;
  }
}

export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const dir = resolveMediaScopedDir(subdir, "saveMediaBuffer");
  const uuid = crypto.randomUUID();
  const headerExt = extensionForMime(normalizeOptionalString(contentType?.split(";")[0]));
  const mime = await detectMime({ buffer, headerMime: contentType });
  const ext =
    headerExt ?? extensionForMime(mime) ?? safeOriginalFilenameExtension(originalFilename) ?? "";
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  const materializedPath = await saveMediaBufferWithId({ subdir, id, buffer, contentType: mime });
  return buildSavedMediaResult({
    dir,
    id,
    size: buffer.byteLength,
    contentType: mime,
    path: materializedPath,
  });
}

/**
 * Resolves a media ID saved by saveMediaBuffer to a temporary local path.
 *
 * This is the read-side counterpart to saveMediaBuffer and is used by the
 * agent runner to hydrate opaque `media://inbound/<id>` URIs written by the
 * Gateway's claim-check offload path.
 *
 * Security:
 * - Rejects IDs and subdirs containing path traversal, absolute paths, empty
 *   segments, or null bytes to prevent path injection outside the media root.
 * - Materializes the SQLite blob with the write-side MEDIA_FILE_MODE policy.
 *
 * @param id      The media ID as returned by SavedMedia.id (may include
 *                extension and original-filename prefix,
 *                e.g. "photo---<uuid>.png" or "图片---<uuid>.png").
 * @param subdir  The subdirectory the file was saved into (default "inbound").
 * @returns       Absolute path to a temporary materialization of the SQLite blob.
 * @throws        If the ID is unsafe or the SQLite blob is missing.
 *
 * Prefer readMediaBuffer when the caller needs the bytes; this path-returning
 * helper is only for channel surfaces that still need a local attachment path.
 */
export async function resolveMediaBufferPath(id: string, subdir = "inbound"): Promise<string> {
  const safeSubdir = resolveMediaSubdir(subdir, "resolveMediaBufferPath");
  resolveMediaRelativePath(id, subdir, "resolveMediaBufferPath");
  const row = getMediaBlobRow({ subdir: safeSubdir, id });
  if (!row) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }
  return await materializeMediaBufferPath({
    subdir: safeSubdir,
    id,
    buffer: Buffer.from(row.blob),
  });
}

export type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};

export async function readMediaBuffer(
  id: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
): Promise<ReadMediaBufferResult> {
  const safeSubdir = resolveMediaSubdir(subdir, "readMediaBuffer");
  resolveMediaRelativePath(id, subdir, "readMediaBuffer");
  const row = getMediaBlobRow({ subdir: safeSubdir, id });
  if (!row) {
    throw new Error(`readMediaBuffer: media ID does not resolve to a file: ${JSON.stringify(id)}`);
  }
  if (row.size_bytes > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} is ${row.size_bytes} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  const buffer = Buffer.from(row.blob);
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} read ${buffer.byteLength} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  const materializedPath = await materializeMediaBufferPath({ subdir: safeSubdir, id, buffer });
  return { id, path: materializedPath, buffer, size: buffer.byteLength };
}

/**
 * Deletes media previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up media that was
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned SQLite
 * rows and temporary materializations ahead of the periodic TTL sweep.
 *
 * Uses a media-root handle to apply the same path-safety guards as the read
 * path while removing the matching SQLite row and temp materialization.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
export async function deleteMediaBuffer(id: string, subdir: "inbound" = "inbound"): Promise<void> {
  const safeSubdir = resolveMediaSubdir(subdir, "deleteMediaBuffer");
  resolveMediaRelativePath(id, subdir, "deleteMediaBuffer");
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getMediaKysely(database.db)
        .deleteFrom("media_blobs")
        .where("subdir", "=", safeSubdir)
        .where("id", "=", id),
    );
  });
  await fs.rm(path.join(resolveMediaScopedDir(subdir, "deleteMediaBuffer"), id), {
    force: true,
  });
}
