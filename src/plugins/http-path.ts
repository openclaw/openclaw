import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalizes plugin HTTP route paths to a leading-slash path, using fallback when empty. */
export function normalizePluginHttpPath(
  path?: string | null,
  fallback?: string | null,
): string | null {
  const trimmed = normalizeOptionalString(path);
  if (!trimmed) {
    const fallbackTrimmed = normalizeOptionalString(fallback);
    if (!fallbackTrimmed) {
      return null;
    }
    // Plugin manifests and SDK helpers accept either "foo" or "/foo"; registry matching
    // stores only the slash-prefixed shape.
    return fallbackTrimmed.startsWith("/") ? fallbackTrimmed : `/${fallbackTrimmed}`;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
