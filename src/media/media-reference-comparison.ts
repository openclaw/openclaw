import path from "node:path";
import { fileURLToPath } from "node:url";

const PATH_PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const FILE_URL_PREFIX_LENGTH = "file://".length;

function normalizeMalformedLocalFileUrl(value: string): string | undefined {
  const remainder = value.slice(FILE_URL_PREFIX_LENGTH);
  let localPath: string;
  if (remainder.startsWith("/")) {
    localPath = remainder;
  } else if (/^localhost(?:\/|$)/iu.test(remainder)) {
    localPath = remainder.slice("localhost".length);
  } else {
    return undefined;
  }
  if (process.platform === "win32" && /^\/[a-z]:[\\/]/iu.test(localPath)) {
    localPath = localPath.slice(1);
  }
  return PATH_PARENT_SEGMENT_RE.test(localPath) ? localPath : path.normalize(localPath);
}

/** Canonicalizes equivalent local media references without resolving the filesystem. */
export function normalizeMediaReferenceForComparison(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return path.isAbsolute(trimmed) && !PATH_PARENT_SEGMENT_RE.test(trimmed)
      ? path.normalize(trimmed)
      : trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return path.normalize(fileURLToPath(parsed));
    }
  } catch {
    // Preserve the historical fallback for malformed local URLs without conflating remote hosts.
  }
  return normalizeMalformedLocalFileUrl(trimmed) ?? trimmed;
}
