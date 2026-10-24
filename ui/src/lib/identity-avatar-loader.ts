import { AVATAR_MAX_BYTES, isAvatarImageMimeType } from "../../../src/shared/avatar-limits.js";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "./identity-avatar-context.ts";
import { resolveTrustedAvatarUrl } from "./identity-avatar.ts";

const IDENTITY_AVATAR_CACHE_MAX_ENTRIES = 128;
const IDENTITY_AVATAR_FETCH_TIMEOUT_MS = 30_000;
const IDENTITY_AVATAR_FAILURE_TTL_MS = 60_000;
const IDENTITY_AVATAR_SNAPSHOT_MAX_BYTES = 128 * 1024;

export type IdentityAvatarSnapshot = { url: string; dataUrl: string | null; retryAt?: number };

type CachedIdentityAvatar = {
  blobUrl: string | null;
  blob: Blob | null;
  references: number;
  settled: boolean;
  retryAt?: number;
  promise: Promise<string | null>;
  decoded?: HTMLImageElement;
};

const identityAvatarCache = new Map<string, CachedIdentityAvatar>();
let identityAvatarGeneration = 0;

function clearIdentityAvatarCache(): void {
  identityAvatarGeneration += 1;
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

function loadIdentityAvatar(url: string): string | Promise<string | null> | null {
  const cached = identityAvatarCache.get(url);
  // Map order is the LRU order; concurrent roster, profile, and chat views
  // share the authenticated request and its result, including a cached miss.
  identityAvatarCache.delete(url);
  if (cached && (cached.retryAt === undefined || Date.now() < cached.retryAt)) {
    identityAvatarCache.set(url, cached);
    return cached.blobUrl ?? (cached.retryAt === undefined ? cached.promise : null);
  }

  const entry: CachedIdentityAvatar = {
    blobUrl: null,
    blob: null,
    references: 0,
    settled: false,
    promise: Promise.resolve(null),
  };
  entry.promise = (async () => {
    try {
      // Cold images must not start all authenticated fetches inside the row
      // construction task. Cached images still resolve synchronously above.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
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
      entry.blob = blob;
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

function revisionedAvatarUrl(value: string): string | null {
  const { origin, resourceBasePath } = readAvatarGatewayContext();
  const trusted = resolveTrustedAvatarUrl(value, origin, resourceBasePath);
  return trusted && new URL(trusted, "https://origin-probe.invalid").searchParams.get("v")?.trim()
    ? trusted
    : null;
}

/** The admitted sidebar snapshot owns persistence; only its visible, revisioned images travel. */
export async function captureIdentityAvatarSnapshot(
  urls: readonly string[],
): Promise<IdentityAvatarSnapshot[]> {
  const generation = identityAvatarGeneration;
  const images: IdentityAvatarSnapshot[] = [];
  let bytes = 0;
  for (const value of new Set(urls)) {
    const url = revisionedAvatarUrl(value);
    const entry = url ? identityAvatarCache.get(url) : undefined;
    if (entry && !entry.blobUrl && !entry.settled) {
      await entry.promise;
    }
    if (generation !== identityAvatarGeneration) {
      return [];
    }
    if (!url || !entry || identityAvatarCache.get(url) !== entry) {
      continue;
    }
    if (!entry.blobUrl || !entry.blob) {
      const size = url.length + String(entry.retryAt).length;
      if (
        entry.retryAt !== undefined &&
        Date.now() < entry.retryAt &&
        bytes + size <= IDENTITY_AVATAR_SNAPSHOT_MAX_BYTES
      ) {
        images.push({ url, dataUrl: null, retryAt: entry.retryAt });
        bytes += size;
      }
      continue;
    }
    const type = entry.blob.type.split(";")[0];
    const prefix = `data:${type};base64,`;
    const size = url.length + prefix.length + Math.ceil(entry.blob.size / 3) * 4;
    if (bytes + size > IDENTITY_AVATAR_SNAPSHOT_MAX_BYTES) {
      continue;
    }
    const binary = Array.from(new Uint8Array(await entry.blob.arrayBuffer()), (byte) =>
      String.fromCharCode(byte),
    ).join("");
    if (generation !== identityAvatarGeneration) {
      return [];
    }
    if (identityAvatarCache.get(url) !== entry) {
      continue;
    }
    images.push({ url, dataUrl: prefix + btoa(binary) });
    bytes += size;
  }
  return images;
}

/** Call only after snapshot scope admission; retire these images with that scope. */
export function restoreIdentityAvatarSnapshot(images: readonly IdentityAvatarSnapshot[]): {
  release: () => void;
  ready: Promise<void>;
} {
  const restored = new Map<string, CachedIdentityAvatar>();
  let bytes = 0;
  for (const image of images) {
    const url = revisionedAvatarUrl(image.url);
    const size = image.url.length + (image.dataUrl?.length ?? String(image.retryAt).length);
    if (!url || identityAvatarCache.has(url) || bytes + size > IDENTITY_AVATAR_SNAPSHOT_MAX_BYTES) {
      continue;
    }
    if (image.dataUrl === null) {
      if (image.retryAt !== undefined && Date.now() < image.retryAt) {
        const entry: CachedIdentityAvatar = {
          blobUrl: null,
          blob: null,
          references: 0,
          settled: true,
          retryAt: image.retryAt,
          promise: Promise.resolve(null),
        };
        identityAvatarCache.set(url, entry);
        restored.set(url, entry);
        bytes += size;
      }
      continue;
    }
    const data = /^data:([^;,]+);base64,([a-z\d+/]*={0,2})$/iu.exec(image.dataUrl);
    if (!data?.[1] || data[2] === undefined || !isAvatarImageMimeType(data[1])) {
      continue;
    }
    try {
      const binary = atob(data[2]);
      const blob = new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
        type: data[1],
      });
      if (!blob.size) {
        continue;
      }
      const blobUrl = URL.createObjectURL(blob);
      const entry: CachedIdentityAvatar = {
        blobUrl,
        blob,
        references: 0,
        settled: true,
        promise: Promise.resolve(blobUrl),
      };
      identityAvatarCache.set(url, entry);
      restored.set(url, entry);
      bytes += size;
    } catch {
      // Disposable cache corruption cannot replace an authenticated resource read.
    }
  }
  trimIdentityAvatarCache();
  const ready =
    typeof Image !== "undefined" && typeof Image.prototype.decode === "function"
      ? Promise.all(
          [...restored]
            .filter(([, entry]) => entry.blobUrl !== null)
            .map(async ([url, entry]) => {
              const image = new Image();
              entry.decoded = image;
              image.src = entry.blobUrl!;
              try {
                await image.decode();
              } catch {
                if (identityAvatarCache.get(url) === entry) {
                  URL.revokeObjectURL(entry.blobUrl!);
                  entry.blobUrl = null;
                  entry.blob = null;
                  entry.decoded = undefined;
                  entry.promise = Promise.resolve(null);
                  entry.retryAt = Date.now() + IDENTITY_AVATAR_FAILURE_TTL_MS;
                }
              }
            }),
        ).then(() => undefined)
      : Promise.resolve();
  return {
    ready,
    release: () => {
      for (const [url, entry] of restored) {
        if (identityAvatarCache.get(url) === entry) {
          identityAvatarCache.delete(url);
          if (entry.blobUrl) {
            URL.revokeObjectURL(entry.blobUrl);
          }
        }
      }
      restored.clear();
    },
  };
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
  // Connected same-origin routes need the loader too: it resolves a missing
  // avatar before Lit can reconcile an <img> error back over its initials.
  return origin || authTokens.length ? loadIdentityAvatar(trusted) : trusted;
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

/** Synchronous view leases; the shared Gateway cache owns image bytes. */
export function createIdentityAvatars() {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let connected = false;
  let unsubscribeGatewayReset: (() => void) | undefined;
  const routes = new Map<
    string,
    { url: string | null; result: string | Promise<string | null> | null; release?: () => void }
  >();
  let activeRoutes: Set<string> | null = null;
  let generation = identityAvatarGeneration;
  function clearRoutes() {
    for (const route of routes.values()) {
      route.release?.();
    }
    routes.clear();
  }
  function disconnect() {
    connected = false;
    unsubscribeGatewayReset?.();
    unsubscribeGatewayReset = undefined;
    clearRoutes();
  }
  return {
    connect() {
      connected = true;
      unsubscribeGatewayReset = registerAvatarGatewayReset(notify);
      notify();
      return disconnect;
    },
    disconnect,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    withActiveRoutes<T>(render: () => T): T {
      activeRoutes = new Set();
      try {
        return render();
      } finally {
        for (const [key, route] of routes) {
          if (!activeRoutes.has(key)) {
            route.release?.();
            routes.delete(key);
          }
        }
        activeRoutes = null;
      }
    },
    imageErrorHandler(value: string): () => void {
      const route = routes.get(value);
      return () => {
        // An old image may fail after its view or Gateway context was replaced.
        if (
          !route?.url ||
          !connected ||
          generation !== identityAvatarGeneration ||
          routes.get(value) !== route
        ) {
          return;
        }
        route.url = null;
        notify();
      };
    },
    resolve(value: string): string | null {
      if (!connected) {
        return null;
      }
      if (generation !== identityAvatarGeneration) {
        clearRoutes();
        generation = identityAvatarGeneration;
      }
      activeRoutes?.add(value);
      const result = value.startsWith("/") ? resolveAvatarImageUrl(value) : value;
      const cached = routes.get(value);
      if (cached && cached.result === result) {
        return cached.url;
      }
      const route: { url: string | null; result: typeof result; release?: () => void } = {
        // Keep the configured source visible until the shared fetch settles.
        url: value,
        result,
        release: retainAvatarImageUrl(result),
      };
      routes.set(value, route);
      const apply = (url: string | null) => {
        if (generation !== identityAvatarGeneration || routes.get(value) !== route) {
          route.release?.();
          return;
        }
        route.url = url;
      };
      if (typeof result === "string" || result === null) {
        apply(result);
      } else {
        void result.then((url) => {
          apply(url);
          if (connected && routes.get(value) === route) {
            notify();
          }
        });
      }
      cached?.release?.();
      return route.url;
    },
  };
}

export type IdentityAvatars = ReturnType<typeof createIdentityAvatars>;
