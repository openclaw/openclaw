import path from "node:path";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { realpathOrResolve } from "../infra/path-existence.js";
import { relativePathEscapesRoot } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";

export {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";

type InboundMediaReference = {
  id: string;
  physicalPath: string;
};

type MediaReferenceSourceInfo = {
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
};

/** Classifies media reference schemes before local resolution or sandbox rewriting. */
export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): MediaReferenceSourceInfo {
  const allowDataUrl = options?.allowDataUrl ?? true;
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
  const isFileUrl = /^file:/i.test(source);
  const isHttpUrl = hasHttpUrlPrefix(source);
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

/** Converts a managed inbound path to a URI without exposing paths outside its store. */
export function buildInboundMediaUriFromPath(source: string): string | undefined {
  const localPath = maybeLocalPathFromSource(source.trim());
  if (!localPath) {
    return undefined;
  }
  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const relativePath = path.relative(inboundDir, path.resolve(localPath));
  // The inbound id must be a single path component that does not escape the store bucket;
  // reject traversal, nested segments, and absolute/empty results.
  if (
    !relativePath ||
    relativePathEscapesRoot(relativePath) ||
    relativePath.includes(path.sep) ||
    relativePath.includes("\\")
  ) {
    return undefined;
  }
  try {
    const parsed = parseInboundMediaUri(`media://inbound/${relativePath}`);
    return parsed?.normalizedSource;
  } catch {
    // Malformed percent-encoded ids (e.g. a stray `%`) make the URI decoder throw;
    // redact instead of propagating the failure into the shared history projection.
    return undefined;
  }
}

/** Rewrites inbound media-store URIs to sandbox-relative paths for staged agent inputs. */
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

/** Resolves inbound media:// URIs or first-level inbound file paths to concrete store files. */
export async function resolveInboundMediaReference(
  source: string,
): Promise<InboundMediaReference | null> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!normalizedSource) {
    return null;
  }

  const uri = parseInboundMediaUri(normalizedSource);
  if (uri) {
    return {
      id: uri.id,
      physicalPath: await resolveInboundMediaPath(uri.id, uri.normalizedSource),
    };
  }

  const localPath = maybeLocalPathFromSource(normalizedSource);
  if (!localPath) {
    return null;
  }

  const rawInboundDir = path.resolve(getMediaDir(), "inbound");
  const rawResolvedPath = path.resolve(localPath);
  const rawRel = path.relative(rawInboundDir, rawResolvedPath);
  // Realpath fallback catches symlinks and moved state dirs before accepting direct paths.
  const rel =
    rawRel && !relativePathEscapesRoot(rawRel)
      ? rawRel
      : path.relative(await realpathOrResolve(rawInboundDir), await realpathOrResolve(localPath));
  if (!rel || relativePathEscapesRoot(rel) || rel.includes(path.sep)) {
    return null;
  }

  return {
    id: rel,
    physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
  };
}

/** Resolves a media reference while preserving whether it belongs to the inbound store. */
export async function resolveMediaReferenceLocalPathInfo(source: string) {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const inboundReference = await resolveInboundMediaReference(normalizedSource);
  return inboundReference
    ? { kind: "inbound" as const, path: inboundReference.physicalPath }
    : { kind: "local" as const, path: normalizedSource };
}

/** Converts inbound media references for callers that need a direct local file path. */
export async function resolveMediaReferenceLocalPath(source: string): Promise<string> {
  return (await resolveMediaReferenceLocalPathInfo(source)).path;
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
