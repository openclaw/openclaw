import path from "node:path";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { resolveUserPath } from "../infra/home-dir.js";
import { relativePathEscapesRoot } from "../infra/path-guards.js";
import { parseInboundMediaUri } from "./inbound-media-uri.js";
import { getMediaDir } from "./store-path.js";

export function maybeLocalPathFromSource(source: string): string | null {
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
