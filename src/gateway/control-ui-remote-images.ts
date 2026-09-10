// Exact-origin policy shared by Control UI bootstrap validation and its CSP.

/** Normalizes one bare HTTP(S) origin, or rejects it when it carries extra URL state. */
export function normalizeControlUiRemoteImageOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null" ||
      !url.hostname ||
      url.hostname.includes("*")
    ) {
      return undefined;
    }
    // URL canonicalizes case, IDNs, and default ports; trailing DNS dots are
    // equivalent but would otherwise make an avoidable second policy spelling.
    url.hostname = url.hostname.replace(/\.+$/, "");
    return url.hostname && url.port !== "0" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeControlUiRemoteImageOrigins(values?: readonly string[]): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map(normalizeControlUiRemoteImageOrigin)
        .filter((value): value is string => value !== undefined),
    ),
  ).toSorted();
}
