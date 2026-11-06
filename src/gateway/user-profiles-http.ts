import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { getRuntimeConfig } from "../config/io.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveHostAccountAvatar } from "../infra/host-account-avatar.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import { LruCache } from "../infra/lru-cache.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { createProfileAvatarReader } from "../state/user-profiles-avatar.js";
import { formatUserProfileAvatarEtag, UserProfileNotFoundError } from "../state/user-profiles.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { setControlUiImageCorsHeaders } from "./control-ui-image-cors.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { sendJson, sendMethodNotAllowed, watchClientDisconnect } from "./http-common.js";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";

const GRAVATAR_BASE_URL = "https://www.gravatar.com/avatar";
const REMOTE_AVATAR_FETCH_TIMEOUT_MS = 5_000;
// Bound the total wait across GitHub and linked-email lookups, not each lookup alone.
const REMOTE_AVATAR_TOTAL_TIMEOUT_MS = 6_000;
const REMOTE_AVATAR_CACHE_MAX_ENTRIES = 256;
const REMOTE_AVATAR_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const REMOTE_AVATAR_HIT_TTL_MS = 24 * 60 * 60_000;
const REMOTE_AVATAR_MISS_TTL_MS = 15 * 60_000;
const MAX_REMOTE_AVATAR_BYTES = 1_000_000;
// Bound upstream disclosure when every earlier linked email misses.
const MAX_GRAVATAR_EMAIL_LOOKUPS = 8;
const REMOTE_AVATAR_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type RemoteAvatarHit = {
  kind: "hit";
  bytes: Uint8Array;
  mime: string;
  etag: string;
};

type RemoteAvatarResult = RemoteAvatarHit | { kind: "miss" } | { kind: "error" };
type CachedRemoteAvatarResult = Exclude<RemoteAvatarResult, { kind: "error" }> & {
  expiresAtMs: number;
};

const remoteAvatarCache = new LruCache<CachedRemoteAvatarResult>(REMOTE_AVATAR_CACHE_MAX_ENTRIES, {
  maxBytes: REMOTE_AVATAR_CACHE_MAX_BYTES,
  sizeOf: (result) => (result.kind === "hit" ? result.bytes.byteLength : 0),
});
const remoteAvatarRequests = new Map<string, Promise<RemoteAvatarResult>>();

function getCachedRemoteAvatar(url: string, nowMs: number): RemoteAvatarResult | undefined {
  const cached = remoteAvatarCache.get(url);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= nowMs) {
    remoteAvatarCache.delete(url);
    return undefined;
  }
  return cached.kind === "hit"
    ? { kind: "hit", bytes: cached.bytes, mime: cached.mime, etag: cached.etag }
    : { kind: "miss" };
}

function cacheRemoteAvatar(
  url: string,
  result: Exclude<RemoteAvatarResult, { kind: "error" }>,
  nowMs: number,
) {
  const ttlMs = result.kind === "hit" ? REMOTE_AVATAR_HIT_TTL_MS : REMOTE_AVATAR_MISS_TTL_MS;
  remoteAvatarCache.set(url, { ...result, expiresAtMs: nowMs + ttlMs });
}

async function cancelRemoteAvatarBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The response is already unusable; cancellation is only best-effort cleanup.
  }
}

async function fetchRemoteAvatar(url: string): Promise<RemoteAvatarResult> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      signal: AbortSignal.timeout(REMOTE_AVATAR_FETCH_TIMEOUT_MS),
      redirect: url.startsWith(GRAVATAR_BASE_URL + "/") ? "follow" : "error",
    });
    if (response.status === 404) {
      await cancelRemoteAvatarBody(response.body);
      return { kind: "miss" };
    }
    if (!response.ok) {
      await cancelRemoteAvatarBody(response.body);
      return { kind: "error" };
    }
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !REMOTE_AVATAR_MIME_TYPES.has(mime) ||
      (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_AVATAR_BYTES)
    ) {
      await cancelRemoteAvatarBody(response.body);
      return { kind: "error" };
    }
    const buffer = await readResponseWithLimit(response, MAX_REMOTE_AVATAR_BYTES);
    if (buffer.byteLength === 0) {
      return { kind: "error" };
    }
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const etag = `"gravatar-${createHash("sha256").update(bytes).digest("hex")}"`;
    return { kind: "hit", bytes, mime, etag };
  } catch {
    return { kind: "error" };
  }
}

async function resolveRemoteAvatar(url: string): Promise<RemoteAvatarResult> {
  const cached = getCachedRemoteAvatar(url, Date.now());
  if (cached) {
    return cached;
  }
  return await getOrCreatePromise(
    remoteAvatarRequests,
    url,
    async () => {
      const result = await fetchRemoteAvatar(url);
      if (result.kind !== "error") {
        cacheRemoteAvatar(url, result, Date.now());
      }
      return result;
    },
    { evictOnSettled: true },
  );
}

function sendAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  avatar: { bytes?: Uint8Array; byteLength: number; mime: string; etag: string },
  revision?: string,
): void {
  const cacheControl =
    revision && new URL(req.url ?? "/", "http://localhost").searchParams.get("v") === revision
      ? "private, max-age=31536000, immutable"
      : "private, max-age=0, must-revalidate";
  if (matchesHttpIfNoneMatch(req.headers["if-none-match"], avatar.etag)) {
    // Carry the success cache policy so a 304 does not inherit the miss-path
    // no-store and force the client to re-download an unchanged avatar.
    res.writeHead(304, { ETag: avatar.etag, "Cache-Control": cacheControl });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": avatar.mime,
    "Content-Length": avatar.byteLength,
    "Cache-Control": cacheControl,
    ETag: avatar.etag,
  });
  res.end(req.method === "HEAD" ? undefined : avatar.bytes);
}

/** Serves a profile avatar to authenticated Control UI readers. */
export async function handleUserProfileAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: GatewayHttpRequestAuthOptions & {
    basePath?: string;
  },
): Promise<boolean> {
  const parsed = parseControlUiUserAvatarPath(pathname, opts.basePath ?? "");
  if (!parsed.matched) {
    return false;
  }
  const method = req.method;
  const cfg = opts.cfg ?? getRuntimeConfig();
  const corsAllowed = setControlUiImageCorsHeaders(req, res, cfg);
  if (method === "OPTIONS") {
    if (!corsAllowed) {
      sendJson(res, 403, { ok: false, error: { type: "origin_not_allowed" } });
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  // Personal avatars share the Control UI read boundary: paired device tokens
  // must retain their approved scopes rather than be treated as shared secrets.
  const authResult = await authorizeControlUiReadRequestOrReply({
    ...opts,
    req,
    res,
    cfg,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    requiredOperatorMethod: "users.self",
  });
  if (!authResult) {
    return true;
  }
  authResult.assertCurrent();
  // Cached misses would hide a later uploaded image behind the unversioned route.
  res.setHeader("Cache-Control", "no-store");
  const profileId = parsed.value;
  // Exact-ID avatar reads expose shared presentation, not the profile directory.
  // Session readers can render known people without users.list access to private
  // emails, roles or account metadata; this endpoint never enumerates profiles.
  if (!profileId) {
    sendJson(res, 404, { ok: false, error: { type: "not_found" } });
    return true;
  }
  let emails: string[];
  let githubAvatarUrl: string | undefined;
  let revision: string;
  try {
    const reader = createProfileAvatarReader(profileId);
    for (;;) {
      const prepared = await reader.inspect();
      authResult.assertCurrent();
      const profile = prepared.profile;
      if (!profile) {
        throw new UserProfileNotFoundError(profileId);
      }
      const uploaded = prepared.avatar;
      if (uploaded) {
        const etag = formatUserProfileAvatarEtag(uploaded.sha256, uploaded.mime);
        const needsBytes =
          method !== "HEAD" && !matchesHttpIfNoneMatch(req.headers["if-none-match"], etag);
        const bytes = needsBytes ? await prepared.loadBytes() : undefined;
        // Device grants may be revoked while image preparation is pending.
        await authResult.revalidate();
        if (!prepared.isCurrent() || (needsBytes && !bytes)) {
          continue;
        }
        sendAvatar(req, res, { ...uploaded, bytes: bytes?.bytes, etag }, etag.slice(1, -1));
        return true;
      }
      // A legacy owner tombstone must never borrow the host photo after a merge.
      const hostAvatar =
        profileId === GATEWAY_OWNER_PROFILE_ID && profile.id === profileId && !profile.mergedInto
          ? await resolveHostAccountAvatar()
          : null;
      await authResult.revalidate();
      if (!prepared.isCurrent()) {
        continue;
      }
      if (hostAvatar) {
        sendAvatar(req, res, {
          ...hostAvatar,
          byteLength: hostAvatar.bytes.byteLength,
          etag: formatUserProfileAvatarEtag(hostAvatar.sha256, hostAvatar.mime),
        });
        return true;
      }
      revision = String(profile.updatedAt);
      emails = prepared.emails;
      githubAvatarUrl = prepared.githubAvatarUrl;
      break;
    }
  } catch (error) {
    authResult.assertCurrent();
    if (error instanceof UserProfileNotFoundError) {
      sendJson(res, 404, { ok: false, error: { type: "not_found" } });
      return true;
    }
    if (
      error instanceof WorkerTaskError &&
      (error.code === "overloaded" || error.code === "timeout")
    ) {
      res.setHeader("Retry-After", "1");
      sendJson(res, 503, { ok: false, error: { type: "avatar_temporarily_unavailable" } });
      return true;
    }
    sendJson(res, 500, { ok: false, error: { type: "profile_lookup_failed" } });
    return true;
  }

  // Resolve linked emails sequentially and stop at the first hit: the primary
  // email keeps precedence, and a secondary email's hash is disclosed to
  // Gravatar only once the earlier one is a definite miss. Shared fetches own
  // their upstream timeout; each HTTP waiter owns its deadline and disconnect.
  const hashes = emails
    .slice(0, MAX_GRAVATAR_EMAIL_LOOKUPS)
    .map((email) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex"));
  const urls = [
    ...(githubAvatarUrl ? [githubAvatarUrl] : []),
    ...hashes.map((hash) => `${GRAVATAR_BASE_URL}/${hash}?s=256&d=404`),
  ];
  const clientAbort = new AbortController();
  const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
  const waiterSignal = AbortSignal.any([
    clientAbort.signal,
    AbortSignal.timeout(REMOTE_AVATAR_TOTAL_TIMEOUT_MS),
  ]);
  let transientFailure = false;
  try {
    for (const url of urls) {
      waiterSignal.throwIfAborted();
      const result = await racePromiseWithAbortSignal(resolveRemoteAvatar(url), waiterSignal);
      waiterSignal.throwIfAborted();
      await authResult.revalidate();
      if (result.kind === "hit") {
        sendAvatar(req, res, { ...result, byteLength: result.bytes.byteLength });
        return true;
      }
      if (result.kind === "error") {
        transientFailure = true;
        break;
      }
    }
  } catch (error) {
    if (!waiterSignal.aborted) {
      throw error;
    }
    transientFailure = true;
  } finally {
    stopWatchingDisconnect();
  }
  if (clientAbort.signal.aborted) {
    return true;
  }
  await authResult.revalidate();
  if (
    !transientFailure &&
    new URL(req.url ?? "/", "http://localhost").searchParams.get("v") === revision
  ) {
    res.setHeader("Cache-Control", "private, max-age=60");
  }
  sendJson(res, transientFailure ? 502 : 404, {
    ok: false,
    error: { type: transientFailure ? "avatar_upstream_unavailable" : "not_found" },
  });
  return true;
}
