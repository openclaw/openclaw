import { normalizeOptionalString } from "../shared/string-coerce.js";

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
    return fallbackTrimmed.startsWith("/") ? fallbackTrimmed : `/${fallbackTrimmed}`;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
