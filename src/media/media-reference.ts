import fs from "node:fs/promises";
import path from "node:path";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolveUserPath } from "../utils.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";

type MediaReferenceErrorCode = "invalid-path" | "path-not-allowed";

export class MediaReferenceError extends Error {
  /** Stable machine-readable reason for media reference rejection. */
  code: MediaReferenceErrorCode;

  constructor(code: MediaReferenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "MediaReferenceError";
  }
}

type InboundMediaReference = {
  /** First-level inbound media id inside the media store. */
  id: string;
  /** Source after MEDIA tag normalization, kept for diagnostics and rewrites. */
  normalizedSource: string;
  /** Resolved local media-store path safe for direct file readers. */
  physicalPath: string;
  /** Whether the reference came from a canonical URI or an already-local path. */
  sourceType: "uri" | "path";
};

type InboundMediaUri = {
  /** First-level inbound media id decoded from media://inbound/<id>. */
  id: string;
  /** Canonical source string after MEDIA tag normalization. */
  normalizedSource: string;
};

/** Normalizes legacy `MEDIA:` prefixes while preserving canonical media-store URIs. */
export function normalizeMediaReferenceSource(source: string): string {
  const trimmed = source.trim();
  if (/^media:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

type MediaReferenceSourceInfo = {
  /** True when the source begins with a URI-like scheme token. */
  hasScheme: boolean;
  /** True when the scheme cannot be consumed by media loading policy. */
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
};

/** Classifies a media reference source before local-path or remote fetch handling. */
export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): MediaReferenceSourceInfo {
  const allowDataUrl = options?.allowDataUrl ?? true;
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
  const isFileUrl = /^file:/i.test(source);
  const isHttpUrl = /^https?:\/\//i.test(source);
  const isDataUrl = /^data:/i.test(source);
  const isMediaStoreUrl = /^media:\/\//i.test(source);
  const hasUnsupportedScheme =
    hasScheme &&
    !looksLikeWindowsDrivePath &&
    !isFileUrl &&
    !isHttpUrl &&
    !isMediaStoreUrl &&
    !(allowDataUrl && isDataUrl);
  return {
    hasScheme,
    hasUnsupportedScheme,
    isDataUrl,
    isFileUrl,
    isHttpUrl,
    isMediaStoreUrl,
    looksLikeWindowsDrivePath,
  };
}

function maybeLocalPathFromSource(source: string): string | null {
  if (/^file:/i.test(source)) {
    try {
      return safeFileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith("~")) {
    return resolveUserPath(source);
  }
  if (path.isAbsolute(source)) {
    return source;
  }
  return null;
}

function relativePathEscapesBase(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    path.isAbsolute(relativePath)
  );
}

async function resolvePathForContainment(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function parseInboundMediaUri(source: string): InboundMediaUri | null {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!/^media:\/\//i.test(normalizedSource)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedSource);
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (parsed.hostname !== "inbound") {
    throw new MediaReferenceError(
      "path-not-allowed",
      `Unsupported media URI location: ${parsed.hostname || "(missing)"}`,
    );
  }

  let id: string;
  try {
    id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  return {
    id,
    normalizedSource,
  };
}

async function resolveInboundMediaUri(
  normalizedSource: string,
): Promise<InboundMediaReference | null> {
  const uri = parseInboundMediaUri(normalizedSource);
  if (!uri) {
    return null;
  }
  return {
    ...uri,
    physicalPath: await resolveInboundMediaPath(uri.id, uri.normalizedSource),
    sourceType: "uri",
  };
}

/** Rewrites inbound media URIs into sandbox-relative paths used for staged agent inputs. */
export function resolveMediaReferenceSandboxPath(
  source: string,
  inboundDir = "media/inbound",
): { resolved: string; rewrittenFrom?: string } {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const uri = parseInboundMediaUri(normalizedSource);
  if (!uri) {
    return { resolved: normalizedSource };
  }
  return {
    resolved: path.posix.join(inboundDir.replace(/\\/g, "/"), uri.id),
    rewrittenFrom: uri.normalizedSource,
  };
}

export async function resolveInboundMediaReference(
  source: string,
): Promise<InboundMediaReference | null> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!normalizedSource) {
    return null;
  }

  const uriSource = await resolveInboundMediaUri(normalizedSource);
  if (uriSource) {
    return uriSource;
  }

  const localPath = maybeLocalPathFromSource(normalizedSource);
  if (!localPath) {
    return null;
  }

  const rawInboundDir = path.resolve(getMediaDir(), "inbound");
  const rawResolvedPath = path.resolve(localPath);
  const rawRel = path.relative(rawInboundDir, rawResolvedPath);
  const rel =
    rawRel && !relativePathEscapesBase(rawRel)
      ? rawRel
      : path.relative(
          await resolvePathForContainment(rawInboundDir),
          await resolvePathForContainment(localPath),
        );
  // Local path references are accepted only for first-level inbound media files. Nested paths,
  // escapes, and symlink targets outside the inbound store must stay invisible to media readers.
  if (!rel || relativePathEscapesBase(rel) || rel.includes(path.sep)) {
    return null;
  }

  return {
    id: rel,
    normalizedSource,
    physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
    sourceType: "path",
  };
}

/** Resolves canonical inbound media references to local files and leaves other sources untouched. */
export async function resolveMediaReferenceLocalPath(source: string): Promise<string> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  return (await resolveInboundMediaReference(normalizedSource))?.physicalPath ?? normalizedSource;
}

async function resolveInboundMediaPath(id: string, source: string): Promise<string> {
  try {
    return await resolveMediaBufferPath(id, "inbound");
  } catch (err) {
    throw new MediaReferenceError(
      "invalid-path",
      err instanceof Error ? err.message : `Invalid media reference: ${source}`,
      { cause: err },
    );
  }
}
