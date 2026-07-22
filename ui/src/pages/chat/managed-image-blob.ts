// Shared managed-outgoing-image blob/data-URL helpers used by chat message
// rendering (`chat-message.ts`) and workspace artifact previews. Managed
// outgoing images live behind an authenticated gateway route, so every
// consumer needs the same auth-header + requester-session-key fetch, the
// same 401/403-vs-other-failure distinction, and the same retained blob URL
// cache so the image lightbox can keep a preview alive after eviction.

type ManagedImageBlobOptions = {
  authToken?: string | null;
  basePath?: string;
};

export type ManagedImageDataUrlResult =
  | { kind: "success"; dataUrl: string }
  | { kind: "denied" }
  | { kind: "unavailable" };

type ManagedImageFetchResult =
  | { kind: "success"; blob: Blob }
  | { kind: "denied" }
  | { kind: "unavailable" };

const managedImageBlobUrlCache = new Map<string, Promise<string | null>>();
const managedImageBlobUrlResolvedCache = new Map<string, string>();
const managedImageBlobUrlMissCache = new Map<string, number>();
const managedImageBlobUrlRetainCounts = new Map<string, number>();
const MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES = 64;
const MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS = 5_000;
const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;

function readManagedImageBlobUrl(cacheKey: string): string | undefined {
  const cached = managedImageBlobUrlResolvedCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, cached);
  return cached;
}

function trimManagedImageBlobUrlCache() {
  while (managedImageBlobUrlResolvedCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const evictable = [...managedImageBlobUrlResolvedCache.keys()].find(
      (cacheKey) => (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) === 0,
    );
    if (!evictable) {
      return;
    }
    const evicted = managedImageBlobUrlResolvedCache.get(evictable);
    managedImageBlobUrlResolvedCache.delete(evictable);
    if (evicted) {
      URL.revokeObjectURL(evicted);
    }
  }
}

/**
 * Retains a resolved blob URL so it survives LRU eviction while the image
 * lightbox still references it. Callers must invoke the returned release
 * function exactly once (e.g. lightbox close) or the entry leaks past its
 * normal cache bound.
 */
export function retainManagedImageBlobUrl(cacheKey: string): (() => void) | undefined {
  if (!managedImageBlobUrlResolvedCache.has(cacheKey)) {
    return undefined;
  }
  managedImageBlobUrlRetainCounts.set(
    cacheKey,
    (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 1) - 1;
    if (remaining <= 0) {
      managedImageBlobUrlRetainCounts.delete(cacheKey);
    } else {
      managedImageBlobUrlRetainCounts.set(cacheKey, remaining);
    }
    trimManagedImageBlobUrlCache();
  };
}

function cacheManagedImageBlobUrl(cacheKey: string, blobUrl: string) {
  const previous = managedImageBlobUrlResolvedCache.get(cacheKey);
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, blobUrl);
  managedImageBlobUrlMissCache.delete(cacheKey);
  if (previous && previous !== blobUrl) {
    URL.revokeObjectURL(previous);
  }

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
}

function hasRecentManagedImageBlobUrlMiss(cacheKey: string): boolean {
  const missAt = managedImageBlobUrlMissCache.get(cacheKey);
  if (missAt === undefined) {
    return false;
  }
  if (Date.now() - missAt >= MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS) {
    managedImageBlobUrlMissCache.delete(cacheKey);
    return false;
  }
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, missAt);
  return true;
}

function cacheManagedImageBlobUrlMiss(cacheKey: string) {
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, Date.now());
  while (managedImageBlobUrlMissCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const oldest = managedImageBlobUrlMissCache.keys().next();
    if (oldest.done) {
      break;
    }
    managedImageBlobUrlMissCache.delete(oldest.value);
  }
}

export function isManagedOutgoingImageUrl(source: string): boolean {
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

export function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ManagedImageBlobOptions,
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  const fetchUrl = buildManagedOutgoingImageFetchUrl(source, opts?.basePath);
  return `${fetchUrl}::${authToken}`;
}

export function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ManagedImageBlobOptions,
): string | undefined {
  return readManagedImageBlobUrl(resolveManagedOutgoingImageBlobUrlCacheKey(source, opts));
}

async function fetchManagedOutgoingImage(
  source: string,
  opts?: ManagedImageBlobOptions,
): Promise<ManagedImageFetchResult> {
  // Defense in depth: callers (chat-message renderer, future workspace
  // preview) are expected to gate on `isManagedOutgoingImageUrl` before
  // resolving, but this guard keeps the shared fetch from ever sending
  // Control UI auth headers to an unexpected origin/path if a caller forgets.
  if (!isManagedOutgoingImageUrl(source)) {
    return { kind: "unavailable" };
  }
  const fetchUrl = buildManagedOutgoingImageFetchUrl(source, opts?.basePath);
  const authToken = opts?.authToken?.trim();
  const headers = new Headers({ Accept: "image/*" });
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
  if (requesterSessionKey) {
    headers.set("x-openclaw-requester-session-key", requesterSessionKey);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("managed outgoing image fetch timed out", "TimeoutError"));
  }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(fetchUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { kind: "denied" };
    }
    if (!res.ok) {
      return { kind: "unavailable" };
    }
    const blob = await res.blob();
    return blob.type.startsWith("image/") ? { kind: "success", blob } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ManagedImageBlobOptions,
): Promise<string | null> {
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts);
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    return cached;
  }
  if (hasRecentManagedImageBlobUrlMiss(cacheKey)) {
    return null;
  }
  let pending = managedImageBlobUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const result = await fetchManagedOutgoingImage(source, opts);
      if (result.kind !== "success") {
        // The render path treats a missing preview as `nothing`; never reject
        // its `until` promise for an optional image fetch or body failure.
        // Blob-URL callers only need a present/absent preview, so denied and
        // unavailable results both surface as `null` here (see
        // `resolveManagedOutgoingImageDataUrl` for the distinguishing path).
        cacheManagedImageBlobUrlMiss(cacheKey);
        return null;
      }
      const blobUrl = URL.createObjectURL(result.blob);
      cacheManagedImageBlobUrl(cacheKey, blobUrl);
      return blobUrl;
    })().finally(() => {
      managedImageBlobUrlCache.delete(cacheKey);
    });
    managedImageBlobUrlCache.set(cacheKey, pending);
  }
  return pending;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("invalid image")),
    );
    reader.addEventListener("error", () => reject(reader.error ?? new Error("image read failed")));
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolves a managed outgoing image as a data URL rather than a blob URL, so
 * callers that outlive the DOM node holding a `<img>` (e.g. workspace
 * artifact previews rendered outside the lightbox retain-count lifecycle)
 * can keep using the image without coordinating blob URL revocation. Unlike
 * `resolveManagedOutgoingImageBlobUrl`, this distinguishes an auth denial
 * (401/403) from a generic fetch failure so callers can render a
 * denied-vs-unavailable state.
 */
export async function resolveManagedOutgoingImageDataUrl(
  source: string,
  opts?: ManagedImageBlobOptions,
): Promise<ManagedImageDataUrlResult> {
  const result = await fetchManagedOutgoingImage(source, opts);
  if (result.kind !== "success") {
    return result;
  }
  try {
    return { kind: "success", dataUrl: await blobToDataUrl(result.blob) };
  } catch {
    return { kind: "unavailable" };
  }
}
