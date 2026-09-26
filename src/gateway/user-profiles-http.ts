// Authenticated HTTP avatar serving and Gravatar proxying for durable user profiles.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { consumeResponseBytes } from "@openclaw/normalization-core";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveHostAccountAvatar } from "../infra/host-account-avatar.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { createProfileAvatarReader } from "../state/user-profiles-avatar.js";
import { formatUserProfileAvatarEtag, UserProfileNotFoundError } from "../state/user-profiles.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { sendJson, sendMethodNotAllowed, watchClientDisconnect } from "./http-common.js";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";

const GRAVATAR_BASE_URL = "https://www.gravatar.com/avatar";
const GRAVATAR_FETCH_TIMEOUT_MS = 5_000;
// Whole-request budget shared across a profile's linked emails. Lookups run
// sequentially (see the resolution loop) so a secondary email's hash is only
// disclosed to Gravatar after the earlier one is a definite miss; this deadline
// bounds the total wait so an unreachable Gravatar cannot stall the held
// connection by GRAVATAR_FETCH_TIMEOUT_MS × linked-email-count.
const GRAVATAR_TOTAL_TIMEOUT_MS = 6_000;
const GRAVATAR_CACHE_MAX_ENTRIES = 256;
const GRAVATAR_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const GRAVATAR_HIT_TTL_MS = 24 * 60 * 60_000;
const GRAVATAR_MISS_TTL_MS = 15 * 60_000;
const MAX_GRAVATAR_BYTES = 1_000_000;
// Bound the Gravatar fan-out per avatar request. Linked emails are primary-first
// and resolved sequentially with short-circuit, so the cap only matters when
// every earlier email misses; it stops a profile with many linked addresses from
// probing an unbounded number of them against Gravatar.
const MAX_GRAVATAR_EMAIL_LOOKUPS = 8;
const GRAVATAR_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function resolveAvatarCorsOrigin(req: IncomingMessage, cfg: OpenClawConfig): string | undefined {
  const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (!rawOrigin) {
    return undefined;
  }
  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password) {
      return undefined;
    }
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const allowed = resolveControlUiAllowedOrigins(cfg);
  return allowed.some((candidate) => candidate.trim() === "*" || candidate.trim() === origin)
    ? origin
    : undefined;
}

function setAvatarCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAvatarCorsOrigin(req, cfg);
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  return true;
}

type GravatarHit = {
  kind: "hit";
  bytes: Uint8Array;
  mime: string;
  etag: string;
};

type GravatarResult = GravatarHit | { kind: "miss" } | { kind: "error" };
type CachedGravatarResult = Exclude<GravatarResult, { kind: "error" }> & { expiresAtMs: number };

const gravatarCache = new Map<string, CachedGravatarResult>();
const gravatarRequests = new Map<string, Promise<GravatarResult>>();
let gravatarCacheBytes = 0;

function deleteCachedGravatar(hash: string): void {
  const cached = gravatarCache.get(hash);
  if (cached?.kind === "hit") {
    gravatarCacheBytes -= cached.bytes.byteLength;
  }
  gravatarCache.delete(hash);
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function getCachedGravatar(hash: string, nowMs: number): GravatarResult | undefined {
  const cached = gravatarCache.get(hash);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= nowMs) {
    deleteCachedGravatar(hash);
    return undefined;
  }
  // Map insertion order is the LRU order. Promote on every hit.
  deleteCachedGravatar(hash);
  gravatarCache.set(hash, cached);
  if (cached.kind === "hit") {
    gravatarCacheBytes += cached.bytes.byteLength;
  }
  return cached.kind === "hit"
    ? { kind: "hit", bytes: cached.bytes, mime: cached.mime, etag: cached.etag }
    : { kind: "miss" };
}

function cacheGravatar(
  hash: string,
  result: Exclude<GravatarResult, { kind: "error" }>,
  nowMs: number,
) {
  const ttlMs = result.kind === "hit" ? GRAVATAR_HIT_TTL_MS : GRAVATAR_MISS_TTL_MS;
  deleteCachedGravatar(hash);
  const cached = { ...result, expiresAtMs: nowMs + ttlMs } satisfies CachedGravatarResult;
  gravatarCache.set(hash, cached);
  if (cached.kind === "hit") {
    gravatarCacheBytes += cached.bytes.byteLength;
  }
  while (
    gravatarCache.size > GRAVATAR_CACHE_MAX_ENTRIES ||
    gravatarCacheBytes > GRAVATAR_CACHE_MAX_BYTES
  ) {
    const oldest = gravatarCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    deleteCachedGravatar(oldest);
  }
}

function normalizeContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBoundedGravatarBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | undefined> {
  if (!body) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    const { size, truncated } = await consumeResponseBytes({
      maxBytes: MAX_GRAVATAR_BYTES,
      read: () => reader.read(),
      onChunk: (chunk) => chunks.push(chunk),
      onLimit: () => reader.cancel(),
    });
    if (truncated) {
      return undefined;
    }
    totalBytes = size;
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    return undefined;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelGravatarBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The response is already unusable; cancellation is only best-effort cleanup.
  }
}

async function fetchGravatar(
  hash: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<GravatarResult> {
  try {
    const response = await fetchImpl(`${GRAVATAR_BASE_URL}/${hash}?s=256&d=404`, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      signal: AbortSignal.timeout(GRAVATAR_FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await cancelGravatarBody(response.body);
      return { kind: "miss" };
    }
    if (!response.ok) {
      await cancelGravatarBody(response.body);
      return { kind: "error" };
    }
    const mime = normalizeContentType(response.headers.get("content-type"));
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !GRAVATAR_MIME_TYPES.has(mime) ||
      (Number.isFinite(declaredLength) && declaredLength > MAX_GRAVATAR_BYTES)
    ) {
      await cancelGravatarBody(response.body);
      return { kind: "error" };
    }
    const bytes = await readBoundedGravatarBody(response.body);
    if (!bytes) {
      return { kind: "error" };
    }
    const etag = `"gravatar-${createHash("sha256").update(bytes).digest("hex")}"`;
    return { kind: "hit", bytes, mime, etag };
  } catch {
    return { kind: "error" };
  }
}

async function resolveGravatar(
  hash: string,
  options: { fetchImpl: typeof globalThis.fetch; nowMs: () => number },
): Promise<GravatarResult> {
  const cached = getCachedGravatar(hash, options.nowMs());
  if (cached) {
    return cached;
  }
  return await getOrCreatePromise(
    gravatarRequests,
    hash,
    async () => {
      const result = await fetchGravatar(hash, options.fetchImpl);
      if (result.kind !== "error") {
        cacheGravatar(hash, result, options.nowMs());
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
  cacheControl: string,
): void {
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
    fetchImpl?: typeof globalThis.fetch;
    nowMs?: () => number;
  },
): Promise<boolean> {
  const parsed = parseControlUiUserAvatarPath(pathname, opts.basePath ?? "");
  if (!parsed.matched) {
    return false;
  }
  const method = req.method;
  const cfg = opts.cfg ?? getRuntimeConfig();
  const corsAllowed = setAvatarCorsHeaders(req, res, cfg);
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
    requiredOperatorMethod: "users.list",
  });
  if (!authResult) {
    return true;
  }
  authResult.assertCurrent();
  // Avatars render as plain <img> against a stable, unversioned route, so a
  // heuristically-cached 404 miss would otherwise hide a later uploaded image.
  // Misses must never be cached; the 200 path overrides this with must-revalidate.
  res.setHeader("Cache-Control", "no-store");
  const profileId = parsed.value;
  if (!profileId) {
    sendJson(res, 404, { ok: false, error: { type: "not_found" } });
    return true;
  }
  let emails: string[];
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
        authResult.assertCurrent();
        if (!prepared.isCurrent() || (needsBytes && !bytes)) {
          continue;
        }
        sendAvatar(
          req,
          res,
          { ...uploaded, bytes: bytes?.bytes, etag },
          "private, max-age=0, must-revalidate",
        );
        return true;
      }
      // A legacy owner tombstone must never borrow the host photo after a merge.
      const hostAvatar =
        profileId === GATEWAY_OWNER_PROFILE_ID && profile.id === profileId && !profile.mergedInto
          ? await resolveHostAccountAvatar()
          : null;
      authResult.assertCurrent();
      if (!prepared.isCurrent()) {
        continue;
      }
      if (hostAvatar) {
        sendAvatar(
          req,
          res,
          {
            ...hostAvatar,
            byteLength: hostAvatar.bytes.byteLength,
            etag: formatUserProfileAvatarEtag(hostAvatar.sha256, hostAvatar.mime),
          },
          "private, max-age=0, must-revalidate",
        );
        return true;
      }
      emails = prepared.emails;
      break;
    }
  } catch (error) {
    authResult.assertCurrent();
    if (error instanceof UserProfileNotFoundError) {
      sendJson(res, 404, { ok: false, error: { type: "not_found" } });
      return true;
    }
    sendJson(res, 500, { ok: false, error: { type: "profile_lookup_failed" } });
    return true;
  }

  // Resolve linked emails sequentially and stop at the first hit: the primary
  // email keeps precedence, and a secondary email's hash is disclosed to
  // Gravatar only once the earlier one is a definite miss. Shared fetches own
  // their upstream timeout; each HTTP waiter owns its deadline and disconnect.
  const hashes = emails.slice(0, MAX_GRAVATAR_EMAIL_LOOKUPS).map(hashEmail);
  const clientAbort = new AbortController();
  const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
  const waiterSignal = AbortSignal.any([
    clientAbort.signal,
    AbortSignal.timeout(GRAVATAR_TOTAL_TIMEOUT_MS),
  ]);
  let transientFailure = false;
  try {
    for (const hash of hashes) {
      waiterSignal.throwIfAborted();
      const result = await racePromiseWithAbortSignal(
        resolveGravatar(hash, {
          fetchImpl: opts.fetchImpl ?? globalThis.fetch,
          nowMs: opts.nowMs ?? Date.now,
        }),
        waiterSignal,
      );
      waiterSignal.throwIfAborted();
      authResult.assertCurrent();
      if (result.kind === "hit") {
        sendAvatar(
          req,
          res,
          { ...result, byteLength: result.bytes.byteLength },
          "private, max-age=0, must-revalidate",
        );
        return true;
      }
      transientFailure ||= result.kind === "error";
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
  authResult.assertCurrent();
  sendJson(res, transientFailure ? 502 : 404, {
    ok: false,
    error: { type: transientFailure ? "avatar_upstream_unavailable" : "not_found" },
  });
  return true;
}
