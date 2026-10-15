/** Normalizes one bare HTTPS origin, or rejects it when it carries extra URL state. */
export function normalizeControlUiRemoteImageOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  // Reject URL syntax that the URL parser would silently discard or normalize.
  if (!/^https:\/\/[^/\\?#@\s]+$/i.test(trimmed)) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
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
    // Preserve browser origin identity, including trailing hostname dots.
    return url.origin;
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
