export type ManagedOutgoingImageOptions = {
  basePath?: string;
  authToken?: string | null;
};

const managedImageBlobUrlCache = new Map<string, Promise<string | null>>();
const managedImageBlobUrlResolvedCache = new Map<string, string>();
const managedImageBlobUrlMissCache = new Map<string, number>();
const MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS = 5_000;

export function resetManagedOutgoingImageBlobUrlCacheForTest() {
  for (const blobUrl of managedImageBlobUrlResolvedCache.values()) {
    URL.revokeObjectURL(blobUrl);
  }
  managedImageBlobUrlCache.clear();
  managedImageBlobUrlResolvedCache.clear();
  managedImageBlobUrlMissCache.clear();
}

export function isManagedOutgoingImageSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("/api/chat/media/outgoing/")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

function resolveManagedOutgoingImageRequesterSessionKey(source: string): string | null {
  try {
    const parsed = new URL(source, window.location.origin);
    const parts = parsed.pathname.split("/");
    const encodedSessionKey = parts[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function buildManagedOutgoingImageFetchUrl(source: string, basePath?: string): string {
  if (!source.startsWith("/")) {
    return source;
  }
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  return `${normalizedBasePath}${source}`;
}

export async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ManagedOutgoingImageOptions,
): Promise<string | null> {
  const authToken = opts?.authToken?.trim() ?? "";
  const fetchUrl = buildManagedOutgoingImageFetchUrl(source, opts?.basePath);
  const cacheKey = `${fetchUrl}::${authToken}`;
  const cached = managedImageBlobUrlResolvedCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const missAt = managedImageBlobUrlMissCache.get(cacheKey);
  if (missAt && Date.now() - missAt < MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS) {
    return null;
  }
  let pending = managedImageBlobUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
      const headers = new Headers({ Accept: "image/*" });
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }
      if (requesterSessionKey) {
        headers.set("x-openclaw-requester-session-key", requesterSessionKey);
      }
      const res = await fetch(fetchUrl, {
        method: "GET",
        headers,
        credentials: "same-origin",
      });
      if (!res.ok) {
        managedImageBlobUrlMissCache.set(cacheKey, Date.now());
        return null;
      }
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) {
        managedImageBlobUrlMissCache.set(cacheKey, Date.now());
        return null;
      }
      const blobUrl = URL.createObjectURL(blob);
      managedImageBlobUrlResolvedCache.set(cacheKey, blobUrl);
      managedImageBlobUrlMissCache.delete(cacheKey);
      return blobUrl;
    })().finally(() => {
      managedImageBlobUrlCache.delete(cacheKey);
    });
    managedImageBlobUrlCache.set(cacheKey, pending);
  }
  return pending;
}
