import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import {
  AVATAR_MAX_BYTES,
  isAvatarImageMimeType,
  isRenderableAvatarImageDataUrl,
} from "../../../src/shared/avatar-limits.js";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "./identity-avatar-context.ts";
import { resolveTrustedAvatarUrl } from "./identity-avatar.ts";
import { listen } from "./reactive/listener.ts";

const IDENTITY_AVATAR_CACHE_MAX_ENTRIES = 128;
const IDENTITY_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const IDENTITY_AVATAR_FAILURE_TTL_MS = 60_000;
const KNOWN_AVATAR_STORAGE_PREFIX = "openclaw.identityAvatars.v1:";
const KNOWN_AVATAR_STORAGE_MAX_BYTES = 64 * 1024;

type CachedIdentityAvatar = {
  blobUrl: string | null;
  references: number;
  settled: boolean;
  retryAt?: number;
  promise: Promise<string | null>;
};

const identityAvatarCache = new Map<string, CachedIdentityAvatar>();
let identityAvatarGeneration = 0;
let knownAvatarUrls: Set<string> | undefined;
let pendingAvatarTurn: Promise<void> | undefined;

function nextAvatarTurn(): Promise<void> {
  return (pendingAvatarTurn ??= new Promise<void>((resolve) => {
    setTimeout(() => {
      pendingAvatarTurn = undefined;
      resolve();
    }, 0);
  }));
}

function knownAvatarStorageKey(): string | null {
  const { origin, resourceBasePath, storageScope } = readAvatarGatewayContext();
  return origin && storageScope
    ? KNOWN_AVATAR_STORAGE_PREFIX + JSON.stringify([origin, resourceBasePath, storageScope])
    : null;
}

function readKnownAvatarUrls(): Set<string> {
  if (knownAvatarUrls) {
    return knownAvatarUrls;
  }
  knownAvatarUrls = new Set();
  const key = knownAvatarStorageKey();
  if (key) {
    try {
      const storage = getSafeLocalStorage();
      const raw = storage?.getItem(key);
      const urls: unknown =
        raw && raw.length <= KNOWN_AVATAR_STORAGE_MAX_BYTES ? JSON.parse(raw) : null;
      if (isStringArray(urls) && urls.length <= IDENTITY_AVATAR_CACHE_MAX_ENTRIES) {
        knownAvatarUrls = new Set(urls);
      } else if (raw) {
        storage?.removeItem(key);
      }
    } catch {
      // URL hints are disposable; storage must never prevent an authenticated read.
    }
  }
  return knownAvatarUrls;
}

function persistKnownAvatarUrls(): void {
  const key = knownAvatarStorageKey();
  if (!key || !knownAvatarUrls) {
    return;
  }
  try {
    const json = JSON.stringify([...knownAvatarUrls]);
    const storage = getSafeLocalStorage();
    if (json.length <= KNOWN_AVATAR_STORAGE_MAX_BYTES) {
      storage?.setItem(key, json);
    } else {
      storage?.removeItem(key);
    }
  } catch {
    // Successful in-document reads remain usable without persistent hints.
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Persist URL facts once when leaving, never image bytes or per-row boot writes.
  listen(window, "pagehide", persistKnownAvatarUrls);
}

function clearIdentityAvatarCache(): void {
  identityAvatarGeneration += 1;
  knownAvatarUrls = undefined;
  const key = knownAvatarStorageKey();
  if (key) {
    try {
      getSafeLocalStorage()?.removeItem(key);
    } catch {
      // Retire in-memory facts even when optional storage is unavailable.
    }
  }
  for (const entry of identityAvatarCache.values()) {
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }
  identityAvatarCache.clear();
}

// The loader is lazy, but once loaded it must release blobs immediately when
// the owning Gateway or credential context changes.
registerAvatarGatewayReset(clearIdentityAvatarCache);

function trimIdentityAvatarCache(): void {
  for (const [key, entry] of identityAvatarCache) {
    if (identityAvatarCache.size <= IDENTITY_AVATAR_CACHE_MAX_ENTRIES) {
      break;
    }
    // Pending consumers still need their eventual blob. Evict only settled
    // images or misses, in the Map's LRU order.
    if (!entry.settled || entry.references > 0) {
      continue;
    }
    identityAvatarCache.delete(key);
    if (entry.blobUrl) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }
}

function loadIdentityAvatar(
  url: string,
  directImage: boolean,
): string | Promise<string | null> | null {
  const cached = identityAvatarCache.get(url);
  // Map order is the LRU order; concurrent roster, profile, and chat views
  // share the authenticated request and its result, including a cached miss.
  identityAvatarCache.delete(url);
  if (cached && (cached.retryAt === undefined || Date.now() < cached.retryAt)) {
    identityAvatarCache.set(url, cached);
    return cached.blobUrl ?? (cached.retryAt === undefined ? cached.promise : null);
  }
  // A prior successful read may reuse the browser cache, but never bypass a
  // current request or cached miss. No image bytes are restored during reload.
  if (directImage && readAvatarGatewayContext().storageScope && readKnownAvatarUrls().has(url)) {
    return url;
  }

  const entry: CachedIdentityAvatar = {
    blobUrl: null,
    references: 0,
    settled: false,
    promise: Promise.resolve(null),
  };
  entry.promise = (async () => {
    try {
      // Cold images must not start all authenticated fetches inside the row
      // construction task. Cached images still resolve synchronously above.
      await nextAvatarTurn();
      if (identityAvatarCache.get(url) !== entry) {
        return null;
      }
      const response = await fetchGatewayContextResource(url, IDENTITY_AVATAR_FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > AVATAR_MAX_BYTES || !isAvatarImageMimeType(blob.type)) {
        return null;
      }
      const blobUrl = URL.createObjectURL(blob);
      // A gateway or credential change can finish while its old request is in
      // flight. Never publish an image into the replacement security context.
      if (identityAvatarCache.get(url) !== entry) {
        URL.revokeObjectURL(blobUrl);
        return null;
      }
      entry.blobUrl = blobUrl;
      if (directImage) {
        const urls = readKnownAvatarUrls();
        urls.add(url);
        const oldest = urls.values().next().value;
        if (urls.size > IDENTITY_AVATAR_CACHE_MAX_ENTRIES && oldest !== undefined) {
          urls.delete(oldest);
        }
      }
      trimIdentityAvatarCache();
      return blobUrl;
    } catch {
      return null;
    } finally {
      if (!entry.blobUrl && identityAvatarCache.get(url) === entry) {
        // Incidental rerenders share misses; expiry lets unversioned uploads and
        // transient failures recover. New revisions or credentials bypass the miss.
        entry.settled = true;
        entry.retryAt = Date.now() + IDENTITY_AVATAR_FAILURE_TTL_MS;
        trimIdentityAvatarCache();
      }
    }
  })();
  identityAvatarCache.set(url, entry);
  trimIdentityAvatarCache();
  return entry.promise;
}

/** Cache managed images and misses; caller-owned sources bypass the loader. */
export function resolveAvatarImageUrl(
  value: string,
  unmanagedUrl: string | null = null,
): string | Promise<string | null> | null {
  const { authTokens, origin, resourceBasePath } = readAvatarGatewayContext();
  const trusted = resolveTrustedAvatarUrl(value, origin, resourceBasePath);
  if (!trusted) {
    return unmanagedUrl;
  }
  if (!origin && !authTokens.length) {
    return trusted;
  }
  return loadIdentityAvatar(
    trusted,
    !authTokens.length && origin !== null && origin === globalThis.location?.origin,
  );
}

/** Resolve known display sources without admitting a new authenticated fetch. */
export function readCachedAvatarImageUrl(value: string): string | null {
  if (isRenderableAvatarImageDataUrl(value)) {
    return value;
  }
  if (value.startsWith("blob:")) {
    for (const entry of identityAvatarCache.values()) {
      if (entry.blobUrl === value) {
        return value;
      }
    }
    return null;
  }
  const { authTokens, origin, resourceBasePath, storageScope } = readAvatarGatewayContext();
  const trusted = resolveTrustedAvatarUrl(value, origin, resourceBasePath);
  if (!trusted) {
    return null;
  }
  const cached = identityAvatarCache.get(trusted);
  if (cached) {
    return cached.retryAt === undefined ? cached.blobUrl : null;
  }
  return !authTokens.length &&
    origin !== null &&
    origin === globalThis.location?.origin &&
    storageScope &&
    readKnownAvatarUrls().has(trusted)
    ? trusted
    : null;
}

/** A previously good direct image can disappear; share that miss with later views. */
export function recordAvatarImageError(value: string | Promise<string | null> | null): void {
  if (!value) {
    return;
  }
  const url =
    typeof value === "string" && knownAvatarUrls?.has(value)
      ? value
      : [...identityAvatarCache].find(
          ([, entry]) => entry.promise === value || entry.blobUrl === value,
        )?.[0];
  if (!url || !knownAvatarUrls?.delete(url) || identityAvatarCache.has(url)) {
    return;
  }
  identityAvatarCache.set(url, {
    blobUrl: null,
    references: 0,
    settled: true,
    retryAt: Date.now() + IDENTITY_AVATAR_FAILURE_TTL_MS,
    promise: Promise.resolve(null),
  });
  trimIdentityAvatarCache();
}

/** Acquire before awaiting: each pending or displayed consumer owns its own release. */
export function retainAvatarImageUrl(value: string | Promise<string | null> | null): () => void {
  const entry = value
    ? [...identityAvatarCache.values()].find(
        (item) => item.blobUrl === value || item.promise === value,
      )
    : undefined;
  if (!entry) {
    return () => undefined;
  }
  entry.references += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.references -= 1;
    entry.settled = true;
    trimIdentityAvatarCache();
  };
}

export function readIdentityAvatarGeneration(): number {
  return identityAvatarGeneration;
}
