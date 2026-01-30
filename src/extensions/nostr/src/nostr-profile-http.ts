/**
 * Nostr Profile HTTP Handler
 *
 * Handles HTTP requests for profile management:
 * - PUT /api/channels/nostr/:accountId/profile - Update and publish profile
 * - POST /api/channels/nostr/:accountId/profile/import - Import from relays
 * - GET /api/channels/nostr/:accountId/profile - Get current profile state
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { NostrProfileSchema, type NostrProfile } from "./config-schema.js";
import { publishNostrProfile, getNostrProfileState } from "./channel.js";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";

// ============================================================================
// Types
// ============================================================================

export interface NostrProfileHttpContext {
  /** Get current profile from config */
  getConfigProfile: (accountId: string) => NostrProfile | undefined;
  /** Update profile in config (after successful publish) */
  updateConfigProfile: (accountId: string, profile: NostrProfile) => Promise<void>;
  /** Get account's public key and relays */
  getAccountInfo: (accountId: string) => { pubkey: string; relays: string[] } | null;
  /** Logger */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ============================================================================
// Rate Limiting
// ============================================================================

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 requests per minute

function checkRateLimit(accountId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(accountId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(accountId, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

// ============================================================================
// Mutex for Concurrent Publish Prevention
// ============================================================================

const publishLocks = new Map<string, Promise<void>>();

async function withPublishLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  // Atomic mutex using promise chaining - prevents TOCTOU race condition
  const prev = publishLocks.get(accountId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  // Atomically replace the lock before awaiting - any concurrent request
  // will now wait on our `next` promise
  publishLocks.set(accountId, next);

  // Wait for previous operation to complete
  await prev.catch(() => {});

  try {
    return await fn();
  } finally {
    resolve!();
    // Clean up if we're the last in chain
    if (publishLocks.get(accountId) === next) {
      publishLocks.delete(accountId);
    }
  }
}

// ============================================================================
// SSRF Protection
// ============================================================================

// Block common private/internal hostnames (quick string check)
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

// Check if an IP address (resolved) is in a private range
function isPrivateIp(ip: string): boolean {
  // Handle IPv4
  const ipv4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 172.16.0.0/12 (private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    return false;
  }

  // Handle IPv6
  const ipLower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // ::1 (loopback)
  if (ipLower === "::1") return true;
  // fe80::/10 (link-local)
  if (ipLower.startsWith("fe80:")) return true;
  // fc00::/7 (unique local)
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true;
  // ::ffff:x.x.x.x (IPv4-mapped IPv6) - extract and check IPv4
  const v4Mapped = ipLower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIp(v4Mapped[1]);

  return false;
}

function validateUrlSafety(urlStr: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = new URL(urlStr);

    if (url.protocol !== "https:") {
      return { ok: false, error: "URL must use https:// protocol" };
    }

    const hostname = url.hostname.toLowerCase();

    // Quick hostname block check
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    // Check if hostname is an IP address directly
    if (isPrivateIp(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    // Block suspicious TLDs that resolve to localhost
    if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
}

// Export for use in import validation
export { validateUrlSafety }

// ============================================================================
// Validation Schemas
// ============================================================================

// NIP-05 format: user@domain.com
const nip05FormatSchema = z
  .string()
  .regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid NIP-05 format (user@domain.com)")
  .optional();

// LUD-16 Lightning address format: user@domain.com
const lud16FormatSchema = z
  .string()
  .regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid Lightning address format")
  .optional();

// Extended profile schema with additional format validation
const ProfileUpdateSchema = NostrProfileSchema.extend({
  nip05: nip05FormatSchema,
  lud16: lud16FormatSchema,
});

// ============================================================================
// Request Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function parseAccountIdFromPath(pathname: string): string | null {
  // Match: /api/channels/nostr/:accountId/profile
  const match = pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/profile/);
  return match?.[1] ?? null;
}

// ============================================================================
// HTTP Handler
// ============================================================================

export function createNostrProfileHttpHandler(
  ctx: NostrProfileHttpContext
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Only handle /api/channels/nostr/:accountId/profile paths
    if (!url.pathname.startsWith("/api/channels/nostr/")) {
      return false;
    }

    const accountId = parseAccountIdFromPath(url.pathname);
    if (!accountId) {
      return false;
    }

    const isImport = url.pathname.endsWith("/profile/import");
    const isProfilePath = url.pathname.endsWith("/profile") || isImport;

    if (!isProfilePath) {
      return false;
    }

    // Handle different HTTP methods
    try {
      if (req.method === "GET" && !isImport) {
        return await handleGetProfile(accountId, ctx, res);
      }

      if (req.method === "PUT" && !isImport) {
        return await handleUpdateProfile(accountId, ctx, req, res);
      }

      if (req.method === "POST" && isImport) {
        return await handleImportProfile(accountId, ctx, req, res);
      }

      // Method not allowed
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    } catch (err) {
      ctx.log?.error(`Profile HTTP error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: "Internal server error" });
      return true;
    }
  };
}

// ============================================================================
// GET /api/channels/nostr/:accountId/profile
// ============================================================================

async function handleGetProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  res: ServerResponse
): Promise<true> {
  const configProfile = ctx.getConfigProfile(accountId);
  const publishState = await getNostrProfileState(accountId);

  sendJson(res, 200, {
    ok: true,
    profile: configProfile ?? null,
    publishState: publishState ?? null,
  });
  return true;
}

// ============================================================================
// PUT /api/channels/nostr/:accountId/profile
// ============================================================================

async function handleUpdateProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<true> {
  // Rate limiting
  if (!checkRateLimit(accountId)) {
    sendJson(res, 429, { ok: false, error: "Rate limit exceeded (5 requests/minute)" });
    return true;
  }

  // Parse body
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  // Validate profile
  const parseResult = ProfileUpdateSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    sendJson(res, 400, { ok: false, error: "Validation failed", details: errors });
    return true;
  }

  const profile = parseResult.data;

  // SSRF check for picture URL
  if (profile.picture) {
    const pictureCheck = validateUrlSafety(profile.picture);
    if (!pictureCheck.ok) {
      sendJson(res, 400, { ok: false, error: `picture: ${pictureCheck.error}` });
      return true;
    }
  }

  // SSRF check for banner URL
  if (profile.banner) {
    const bannerCheck = validateUrlSafety(profile.banner);
    if (!bannerCheck.ok) {
      sendJson(res, 400, { ok: false, error: `banner: ${bannerCheck.error}` });
      return true;
    }
  }

  // SSRF check for website URL
  if (profile.website) {
    const websiteCheck = validateUrlSafety(profile.website);
    if (!websiteCheck.ok) {
      sendJson(res, 400, { ok: false, error: `website: ${websiteCheck.error}` });
      return true;
    }
  }

  // Merge with existing profile to preserve unknown fields
  const existingProfile = ctx.getConfigProfile(accountId) ?? {};
  const mergedProfile: NostrProfile = {
    ...existingProfile,
    ...profile,
  };

  // Publish with mutex to prevent concurrent publishes
  try {
    const result = await withPublishLock(accountId, async () => {
      return await publishNostrProfile(accountId, mergedProfile);
    });

    // Only persist if at least one relay succeeded
    if (result.successes.length > 0) {
      await ctx.updateConfigProfile(accountId, mergedProfile);
      ctx.log?.info(`[${accountId}] Profile published to ${result.successes.length} relay(s)`);
    } else {
      ctx.log?.warn(`[${accountId}] Profile publish failed on all relays`);
    }

    sendJson(res, 200, {
      ok: true,
      eventId: result.eventId,
      createdAt: result.createdAt,
      successes: result.successes,
      failures: result.failures,
      persisted: result.successes.length > 0,
    });
  } catch (err) {
    ctx.log?.error(`[${accountId}] Profile publish error: ${String(err)}`);
    sendJson(res, 500, { ok: false, error: `Publish failed: ${String(err)}` });
  }

  return true;
}

// ============================================================================
// POST /api/channels/nostr/:accountId/profile/import
// ============================================================================

async function handleImportProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<true> {
  // Get account info
  const accountInfo = ctx.getAccountInfo(accountId);
  if (!accountInfo) {
    sendJson(res, 404, { ok: false, error: `Account not found: ${accountId}` });
    return true;
  }

  const { pubkey, relays } = accountInfo;

  if (!pubkey) {
    sendJson(res, 400, { ok: false, error: "Account has no public key configured" });
    return true;
  }

  // Parse options from body
  let autoMerge = false;
  try {
    const body = await readJsonBody(req);
    if (typeof body === "object" && body !== null) {
      autoMerge = (body as { autoMerge?: boolean }).autoMerge === true;
    }
  } catch {
    // Ignore body parse errors - use defaults
  }

  ctx.log?.info(`[${accountId}] Importing profile for ${pubkey.slice(0, 8)}...`);

  // Import from relays
  const result = await importProfileFromRelays({
    pubkey,
    relays,
    timeoutMs: 10_000, // 10 seconds for import
  });

  if (!result.ok) {
    sendJson(res, 200, {
      ok: false,
      error: result.error,
      relaysQueried: result.relaysQueried,
    });
    return true;
  }

  // If autoMerge is requested, merge and save
  if (autoMerge && result.profile) {
    const localProfile = ctx.getConfigProfile(accountId);
    const merged = mergeProfiles(localProfile, result.profile);
    await ctx.updateConfigProfile(accountId, merged);
    ctx.log?.info(`[${accountId}] Profile imported and merged`);

    sendJson(res, 200, {
      ok: true,
      imported: result.profile,
      merged,
      saved: true,
      event: result.event,
      sourceRelay: result.sourceRelay,
      relaysQueried: result.relaysQueried,
    });
    return true;
  }

  // Otherwise, just return the imported profile for review
  sendJson(res, 200, {
    ok: true,
    imported: result.profile,
    saved: false,
    event: result.event,
    sourceRelay: result.sourceRelay,
    relaysQueried: result.relaysQueried,
  });
  return true;
}
