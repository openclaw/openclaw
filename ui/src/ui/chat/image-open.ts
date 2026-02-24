const DATA_URL_PREFIX = "data:";
const ALLOWED_OPEN_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

function isAllowedDataImageUrl(url: string): boolean {
  if (!url.toLowerCase().startsWith(DATA_URL_PREFIX)) {
    return false;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < DATA_URL_PREFIX.length) {
    return false;
  }

  const metadata = url.slice(DATA_URL_PREFIX.length, commaIndex);
  const mimeType = metadata.split(";")[0]?.trim().toLowerCase() ?? "";
  return mimeType.startsWith("image/");
}

export function resolveSafeImageOpenUrl(rawUrl: string, baseHref: string): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (isAllowedDataImageUrl(candidate)) {
    return candidate;
  }

  if (candidate.toLowerCase().startsWith(DATA_URL_PREFIX)) {
    return null;
  }

  try {
    const parsed = new URL(candidate, baseHref);
    return ALLOWED_OPEN_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? parsed.toString() : null;
  } catch {
    return null;
  }
}
