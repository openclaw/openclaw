import path from "node:path";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { realpathOrResolve } from "../infra/path-existence.js";
import { relativePathEscapesRoot } from "../infra/path-guards.js";
import { maybeLocalPathFromSource } from "./inbound-media-path.js";
import {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";
import { getMediaDir } from "./store-path.js";
import { resolveMediaBufferPath } from "./store.js";

export {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";

/** Classifies media reference schemes before local resolution or sandbox rewriting. */
export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): {
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
} {
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
export async function resolveInboundMediaReference(source: string): Promise<{
  id: string;
  physicalPath: string;
} | null> {
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
