/** Remote repository transport grammar; the admitted source owns host/path policy. */
export function normalizePluginRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  const raw = value.trim();
  if (!raw || raw.startsWith("-") || /[\s\0]/u.test(raw)) {
    return undefined;
  }
  const url = URL.parse(raw);
  if (
    url &&
    (url.protocol === "https:" || url.protocol === "ssh:") &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "ssh:" || !url.username)
  ) {
    return raw;
  }
  return /^[^@/:]+@[A-Za-z0-9.-]+:[^/].+/u.test(raw) ? raw : undefined;
}
