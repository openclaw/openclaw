// Shared Twilio utilities for channel extensions (twilio-sms, voice-call, etc.).
//
// This module provides webhook signature verification, URL reconstruction for
// proxied environments (Railway, ngrok, Tailscale), and a generic REST API
// helper. The verification code is adapted from extensions/voice-call.

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Generic Webhook Types
// ---------------------------------------------------------------------------

export type HttpHeaderMap = Record<string, string | string[] | undefined>;

export type WebhookContext = {
  headers: HttpHeaderMap;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

// ---------------------------------------------------------------------------
// Header Helpers
// ---------------------------------------------------------------------------

export function getHeader(headers: HttpHeaderMap, name: string): string | undefined {
  const target = name.toLowerCase();
  const direct = headers[target];
  const value =
    direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Replay Cache (prevents processing duplicate webhook deliveries)
// ---------------------------------------------------------------------------

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;
const REPLAY_CACHE_PRUNE_INTERVAL = 64;

type ReplayCache = {
  seenUntil: Map<string, number>;
  calls: number;
};

const twilioReplayCache: ReplayCache = {
  seenUntil: new Map<string, number>(),
  calls: 0,
};

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function pruneReplayCache(cache: ReplayCache, now: number): void {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (expiresAt <= now) {
      cache.seenUntil.delete(key);
    }
  }
  while (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    const oldest = cache.seenUntil.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.seenUntil.delete(oldest);
  }
}

function markReplay(cache: ReplayCache, replayKey: string): boolean {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % REPLAY_CACHE_PRUNE_INTERVAL === 0) {
    pruneReplayCache(cache, now);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing && existing > now) {
    return true;
  }

  cache.seenUntil.set(replayKey, now + REPLAY_WINDOW_MS);
  if (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    pruneReplayCache(cache, now);
  }
  return false;
}

function createSkippedVerificationReplayKey(ctx: WebhookContext): string {
  return `twilio:skip:${sha256Hex(`${ctx.method}\n${ctx.url}\n${ctx.rawBody}`)}`;
}

// ---------------------------------------------------------------------------
// Twilio HMAC-SHA1 Signature Validation
// ---------------------------------------------------------------------------

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

function buildTwilioDataToSign(url: string, params: URLSearchParams): string {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }
  return dataToSign;
}

function buildCanonicalTwilioParamString(params: URLSearchParams): string {
  return Array.from(params.entries())
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * Validate Twilio webhook signature using HMAC-SHA1.
 *
 * Twilio signs requests by concatenating the URL with sorted POST params,
 * then computing HMAC-SHA1 with the auth token.
 *
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: URLSearchParams,
): boolean {
  if (!signature) {
    return false;
  }

  const dataToSign = buildTwilioDataToSign(url, params);
  const expectedSignature = crypto
    .createHmac("sha1", authToken)
    .update(dataToSign)
    .digest("base64");

  return timingSafeEqual(signature, expectedSignature);
}

// ---------------------------------------------------------------------------
// URL Reconstruction (proxy-aware)
// ---------------------------------------------------------------------------

export interface WebhookUrlOptions {
  /**
   * Whitelist of allowed hostnames. If provided, only these hosts will be
   * accepted from forwarding headers. Prevents host header injection.
   */
  allowedHosts?: string[];
  /**
   * Explicitly trust X-Forwarded-* headers without a whitelist.
   * WARNING: Only set this to true if you trust your proxy configuration.
   * @default false
   */
  trustForwardingHeaders?: boolean;
  /**
   * List of trusted proxy IP addresses. X-Forwarded-* headers will only be
   * trusted if the request comes from one of these IPs.
   */
  trustedProxyIPs?: string[];
  /**
   * The IP address of the incoming request (for proxy validation).
   */
  remoteIP?: string;
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) {
    return false;
  }
  const hostnameRegex =
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  return hostnameRegex.test(hostname);
}

function extractHostname(hostHeader: string): string | null {
  if (!hostHeader) {
    return null;
  }

  if (hostHeader.startsWith("[")) {
    const endBracket = hostHeader.indexOf("]");
    if (endBracket === -1) {
      return null;
    }
    return hostHeader.substring(1, endBracket).toLowerCase();
  }

  if (hostHeader.includes("@")) {
    return null;
  }

  const hostname = hostHeader.split(":")[0];
  if (!isValidHostname(hostname)) {
    return null;
  }
  return hostname.toLowerCase();
}

function extractHostnameFromHeader(headerValue: string): string | null {
  const first = headerValue.split(",")[0]?.trim();
  if (!first) {
    return null;
  }
  return extractHostname(first);
}

function normalizeAllowedHosts(allowedHosts?: string[]): Set<string> | null {
  if (!allowedHosts || allowedHosts.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const host of allowedHosts) {
    const extracted = extractHostname(host.trim());
    if (extracted) {
      normalized.add(extracted);
    }
  }
  return normalized.size > 0 ? normalized : null;
}

/**
 * Reconstruct the public webhook URL from request headers.
 *
 * When behind a reverse proxy (Railway, nginx, ngrok, Tailscale), the original
 * URL that Twilio signed against differs from the local request URL. We use
 * standard forwarding headers to reconstruct it.
 *
 * Priority order:
 * 1. X-Forwarded-Proto + X-Forwarded-Host (standard proxy headers)
 * 2. X-Original-Host (nginx)
 * 3. Ngrok-Forwarded-Host (ngrok specific)
 * 4. Host header (direct connection)
 */
export function reconstructWebhookUrl(ctx: WebhookContext, options?: WebhookUrlOptions): string {
  const { headers } = ctx;

  const allowedHosts = normalizeAllowedHosts(options?.allowedHosts);
  const hasAllowedHosts = allowedHosts !== null;
  const explicitlyTrusted = options?.trustForwardingHeaders === true;

  const trustedProxyIPs = options?.trustedProxyIPs?.filter(Boolean) ?? [];
  const hasTrustedProxyIPs = trustedProxyIPs.length > 0;
  const remoteIP = options?.remoteIP ?? ctx.remoteAddress;
  const fromTrustedProxy =
    !hasTrustedProxyIPs || (remoteIP ? trustedProxyIPs.includes(remoteIP) : false);

  const shouldTrustForwardingHeaders = (hasAllowedHosts || explicitlyTrusted) && fromTrustedProxy;
  const isAllowedForwardedHost = (host: string): boolean => !allowedHosts || allowedHosts.has(host);

  let proto = "https";
  if (shouldTrustForwardingHeaders) {
    const forwardedProto = getHeader(headers, "x-forwarded-proto");
    if (forwardedProto === "http" || forwardedProto === "https") {
      proto = forwardedProto;
    }
  }

  let host: string | null = null;
  if (shouldTrustForwardingHeaders) {
    const forwardingHeaders = ["x-forwarded-host", "x-original-host", "ngrok-forwarded-host"];
    for (const headerName of forwardingHeaders) {
      const headerValue = getHeader(headers, headerName);
      if (headerValue) {
        const extracted = extractHostnameFromHeader(headerValue);
        if (extracted && isAllowedForwardedHost(extracted)) {
          host = extracted;
          break;
        }
      }
    }
  }

  if (!host) {
    const hostHeader = getHeader(headers, "host");
    if (hostHeader) {
      const extracted = extractHostnameFromHeader(hostHeader);
      if (extracted) {
        host = extracted;
      }
    }
  }

  if (!host) {
    try {
      const parsed = new URL(ctx.url);
      const extracted = extractHostname(parsed.host);
      if (extracted) {
        host = extracted;
      }
    } catch {
      host = "";
    }
  }

  if (!host) {
    host = "";
  }

  let path = "/";
  try {
    const parsed = new URL(ctx.url);
    path = parsed.pathname + parsed.search;
  } catch {
    // URL parsing failed
  }

  return `${proto}://${host}${path}`;
}

// ---------------------------------------------------------------------------
// Twilio Verification Result
// ---------------------------------------------------------------------------

export interface TwilioVerificationResult {
  ok: boolean;
  reason?: string;
  /** The URL that was used for verification (for debugging) */
  verificationUrl?: string;
  /** Whether we're running behind ngrok free tier */
  isNgrokFreeTier?: boolean;
  /** Request is cryptographically valid but was already processed recently. */
  isReplay?: boolean;
  /** Stable request identity derived from signed Twilio material. */
  verifiedRequestKey?: string;
}

// ---------------------------------------------------------------------------
// Full Twilio Webhook Verification
// ---------------------------------------------------------------------------

function buildTwilioVerificationUrl(
  ctx: WebhookContext,
  publicUrl?: string,
  urlOptions?: WebhookUrlOptions,
): string {
  if (!publicUrl) {
    return reconstructWebhookUrl(ctx, urlOptions);
  }

  try {
    const base = new URL(publicUrl);
    const requestUrl = new URL(ctx.url);
    base.pathname = requestUrl.pathname;
    base.search = requestUrl.search;
    return base.toString();
  } catch {
    return publicUrl;
  }
}

function isLoopbackAddress(address?: string): boolean {
  if (!address) {
    return false;
  }
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (address.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}

function stripPortFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.port) {
      return url;
    }
    parsed.port = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function setPortOnUrl(url: string, port: string): string {
  try {
    const parsed = new URL(url);
    parsed.port = port;
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractPortFromHostHeader(hostHeader?: string): string | undefined {
  if (!hostHeader) {
    return undefined;
  }
  try {
    const parsed = new URL(`https://${hostHeader}`);
    return parsed.port || undefined;
  } catch {
    return undefined;
  }
}

function createTwilioReplayKey(params: {
  verificationUrl: string;
  signature: string;
  requestParams: URLSearchParams;
}): string {
  const canonicalParams = buildCanonicalTwilioParamString(params.requestParams);
  return `twilio:req:${sha256Hex(`${params.verificationUrl}\n${canonicalParams}\n${params.signature}`)}`;
}

/**
 * Verify Twilio webhook with full context and detailed result.
 *
 * Handles URL reconstruction for proxied environments (Railway, ngrok,
 * Tailscale), port variants, replay detection, and ngrok free tier.
 */
export function verifyTwilioWebhook(
  ctx: WebhookContext,
  authToken: string,
  options?: {
    /** Override the public URL (e.g., from config) */
    publicUrl?: string;
    /**
     * Allow ngrok free tier compatibility mode (loopback only).
     * Does NOT bypass signature verification — only enables trusting
     * forwarded headers on loopback so the public URL can be reconstructed.
     */
    allowNgrokFreeTierLoopbackBypass?: boolean;
    /** Skip verification entirely (only for development) */
    skipVerification?: boolean;
    /** Whitelist of allowed hostnames for host header validation. */
    allowedHosts?: string[];
    /**
     * Explicitly trust X-Forwarded-* headers without a whitelist.
     * @default false
     */
    trustForwardingHeaders?: boolean;
    /** List of trusted proxy IP addresses. */
    trustedProxyIPs?: string[];
    /** The remote IP address of the request (for proxy validation). */
    remoteIP?: string;
  },
): TwilioVerificationResult {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey(ctx);
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey,
    };
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature");
  if (!signature) {
    return { ok: false, reason: "Missing X-Twilio-Signature header" };
  }

  const isLoopback = isLoopbackAddress(options?.remoteIP ?? ctx.remoteAddress);
  const allowLoopbackForwarding = options?.allowNgrokFreeTierLoopbackBypass && isLoopback;

  const verificationUrl = buildTwilioVerificationUrl(ctx, options?.publicUrl, {
    allowedHosts: options?.allowedHosts,
    trustForwardingHeaders: options?.trustForwardingHeaders || allowLoopbackForwarding,
    trustedProxyIPs: options?.trustedProxyIPs,
    remoteIP: options?.remoteIP,
  });

  const params = new URLSearchParams(ctx.rawBody);
  const isValid = validateTwilioSignature(authToken, signature, verificationUrl, params);

  if (isValid) {
    const replayKey = createTwilioReplayKey({
      verificationUrl,
      signature,
      requestParams: params,
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }

  // Twilio signatures can differ in whether port is included.
  // Retry a small, deterministic set of URL variants before failing closed.
  const variants = new Set<string>();
  variants.add(verificationUrl);
  variants.add(stripPortFromUrl(verificationUrl));

  if (options?.publicUrl) {
    try {
      const publicPort = new URL(options.publicUrl).port;
      if (publicPort) {
        variants.add(setPortOnUrl(verificationUrl, publicPort));
      }
    } catch {
      // ignore invalid publicUrl
    }
  }

  const hostHeaderPort = extractPortFromHostHeader(getHeader(ctx.headers, "host"));
  if (hostHeaderPort) {
    variants.add(setPortOnUrl(verificationUrl, hostHeaderPort));
  }

  for (const candidateUrl of variants) {
    if (candidateUrl === verificationUrl) {
      continue;
    }
    const isValidCandidate = validateTwilioSignature(authToken, signature, candidateUrl, params);
    if (!isValidCandidate) {
      continue;
    }
    const replayKey = createTwilioReplayKey({
      verificationUrl: candidateUrl,
      signature,
      requestParams: params,
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl: candidateUrl, isReplay, verifiedRequestKey: replayKey };
  }

  const isNgrokFreeTier =
    verificationUrl.includes(".ngrok-free.app") || verificationUrl.includes(".ngrok.io");

  return {
    ok: false,
    reason: `Invalid signature for URL: ${verificationUrl}`,
    verificationUrl,
    isNgrokFreeTier,
  };
}

// ---------------------------------------------------------------------------
// Twilio REST API Helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Twilio REST API.
 */
export async function twilioApiRequest<T = unknown>(params: {
  accountSid: string;
  authToken: string;
  endpoint: string;
  body: URLSearchParams | Record<string, string | string[]>;
  baseUrl?: string;
  method?: "POST" | "GET";
  allowNotFound?: boolean;
}): Promise<T> {
  const base = params.baseUrl ?? "https://api.twilio.com";
  const bodyParams =
    params.body instanceof URLSearchParams
      ? params.body
      : Object.entries(params.body).reduce<URLSearchParams>((acc, [key, value]) => {
          if (Array.isArray(value)) {
            for (const entry of value) {
              acc.append(key, entry);
            }
          } else if (typeof value === "string") {
            acc.append(key, value);
          }
          return acc;
        }, new URLSearchParams());

  const method = params.method ?? "POST";
  const response = await fetch(`${base}${params.endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined),
    },
    ...(method === "POST" ? { body: bodyParams } : undefined),
  });

  if (!response.ok) {
    if (params.allowNotFound && response.status === 404) {
      return undefined as T;
    }
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
