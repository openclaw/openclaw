// Hook request admission: shared-token auth, or a sender signature on paths that declare one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  type createAuthRateLimiter,
  normalizeRateLimitClientIp,
} from "../auth-rate-limit.js";
import { resolveHookPathSignature, verifyStandardWebhooksSignature } from "../hooks-signature.js";
import { type HooksConfigResolved, readHookRequestBody, readJsonBody } from "../hooks.js";
import { sendJson } from "../http-common.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import { resolveRequestClientIpFromHeaders } from "../net.js";

type HookAuthLimiter = ReturnType<typeof createAuthRateLimiter>;

export type HookClientIpConfig = {
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
};

/** Rate-limit subject for a hook request: prepared ingress attribution, else the resolved client IP. */
export function resolveHookClientKeyFor(
  req: IncomingMessage,
  getClientIpConfig?: () => HookClientIpConfig,
): string {
  const attribution = readPreparedGatewayIngressAttribution(req);
  if (attribution && attribution.kind !== "unattributable-proxy") {
    return normalizeRateLimitClientIp(attribution.rateLimit.subject.key);
  }
  const clientIpConfig = getClientIpConfig?.();
  const clientIp =
    resolveRequestClientIpFromHeaders(
      req,
      clientIpConfig?.trustedProxies,
      clientIpConfig?.allowRealIpFallback === true,
    ) ?? req.socket?.remoteAddress;
  return normalizeRateLimitClientIp(clientIp);
}

export type HookRequestAdmission =
  | {
      ok: true;
      /** Parsed request body; `raw` is present when a signature was verified over the exact bytes. */
      body: { value: unknown; raw?: string };
      /** Verified sender delivery id (`webhook-id`); the replay identity for signed deliveries. */
      signedDeliveryId?: string;
      /** Mapping whose secret authenticated the request; scopes its replay cache. */
      signedMappingId?: string;
      /** Replay window the signed mapping accepts; bounds signed-delivery dedupe. */
      signedToleranceSeconds?: number;
      /** Normalized path the signing mapping owns; part of the replay identity. */
      signedPath?: string;
      /** When the signed timestamp stops verifying (`webhook-timestamp` + tolerance), in ms. */
      signedExpiresAtMs?: number;
      /** Configuration current at verification time; the handler continues with it. */
      hooksConfig?: HooksConfigResolved;
      /**
       * Re-checks signing authority against the live configuration after later
       * asynchronous work (transforms); answers 401 and returns false when stale.
       */
      reverify?: () => boolean;
    }
  | { ok: false };

/** 401, or 429 once the client exhausted its failure budget. */
export function sendHookUnauthorized(params: {
  res: ServerResponse;
  clientKey: string;
  limiter: HookAuthLimiter;
  warn: (message: string) => void;
}): void {
  const { res, clientKey, limiter } = params;
  const throttle = limiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
  if (!throttle.allowed) {
    const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
    res.statusCode = 429;
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Too Many Requests");
    params.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
    return;
  }
  limiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
  res.statusCode = 401;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Unauthorized");
}

export async function sendHookBodyError(
  req: IncomingMessage,
  res: ServerResponse,
  error: string,
): Promise<void> {
  const payload = { ok: false, error };
  if (error === "payload too large" || error === "request body timeout") {
    await sendHttpRequestRejection(
      req,
      res,
      error === "payload too large" ? 413 : 408,
      JSON.stringify(payload),
      "application/json; charset=utf-8",
    );
    return;
  }
  sendJson(res, 400, payload);
}

/**
 * Decide whether the request may proceed. A mapping with `signature` owns
 * authentication for its path: the sender proves possession of the signing
 * secret over the exact bytes it sent, and the shared hook token is not
 * required, so producers that cannot attach custom headers (most SaaS webhook
 * senders) can call the Gateway directly. Every other path keeps the token
 * contract. A rejected request has already been answered when `ok` is false.
 */
export async function admitHookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  hooksConfig: HooksConfigResolved;
  /** Re-reads the live configuration; signing authority is checked against it after the body arrives. */
  resolveHooksConfig: () => HooksConfigResolved | null | undefined;
  subPath: string;
  bodyLimit: number;
  headers: Record<string, string>;
  token: string | undefined;
  clientKey: string;
  limiter: HookAuthLimiter;
  warn: (message: string) => void;
}): Promise<HookRequestAdmission> {
  const { req, res, hooksConfig, subPath, clientKey, limiter } = params;
  const reject = () => sendHookUnauthorized({ res, clientKey, limiter, warn: params.warn });
  const owner = subPath ? resolveHookPathSignature(hooksConfig.mappings, subPath) : undefined;
  const pathSignature = owner?.signature;
  if (!owner || !pathSignature) {
    if (!safeEqualSecret(params.token, hooksConfig.token)) {
      reject();
      return { ok: false };
    }
    limiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return { ok: false };
    }
    const parsed = await readJsonBody(req, params.bodyLimit);
    if (!parsed.ok) {
      await sendHookBodyError(req, res, parsed.error);
      return { ok: false };
    }
    return { ok: true, body: { value: parsed.value } };
  }
  const body = await readHookRequestBody(req, params.bodyLimit);
  if (!body.ok) {
    await sendHookBodyError(req, res, body.error);
    return { ok: false };
  }
  // The upload may have outlived a config reload. Authority is whatever the
  // live configuration says now, not the mapping captured before the await:
  // a rotated or removed secret must reject a request that finishes late.
  const current = params.resolveHooksConfig() ?? undefined;
  const currentOwner = current ? resolveHookPathSignature(current.mappings, subPath) : undefined;
  if (!current || !currentOwner?.signature) {
    params.warn(
      `hook ${subPath} rejected: signing authority changed while the request body was read`,
    );
    reject();
    return { ok: false };
  }
  const currentSignature = currentOwner.signature;
  const verification = verifyStandardWebhooksSignature({
    headers: params.headers,
    rawBody: body.value.raw,
    secrets: currentSignature.secrets,
    toleranceSeconds: currentSignature.toleranceSeconds,
  });
  if (!verification.ok) {
    params.warn(
      `hook ${subPath} rejected: ${currentSignature.scheme} signature ${verification.reason}`,
    );
    reject();
    return { ok: false };
  }
  limiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
  const mappingId = currentOwner.mappingId;
  return {
    ok: true,
    body: body.value,
    signedDeliveryId: verification.deliveryId,
    signedMappingId: mappingId,
    signedToleranceSeconds: currentSignature.toleranceSeconds,
    signedPath: currentOwner.matchPath,
    signedExpiresAtMs: (verification.timestamp + currentSignature.toleranceSeconds) * 1000,
    hooksConfig: current,
    reverify: () =>
      ensureSignedAuthorityCurrent({
        mappingId,
        rawBody: body.value.raw,
        resolveHooksConfig: params.resolveHooksConfig,
        subPath,
        headers: params.headers,
        res,
        clientKey,
        limiter,
        warn: params.warn,
      }),
  };
}

/**
 * Remembers verified wake deliveries (mapping id + webhook-id) so a captured
 * signed request cannot enqueue a second wake once the first was consumed.
 * Entries expire after the caller's TTL and the ledger is bounded by size.
 */
export function createSignedWakeDeliveryLedger(maxEntries: number) {
  const entries = new Map<string, number>();
  return {
    has(key: string): boolean {
      const now = Date.now();
      for (const [seen, expiresAt] of entries) {
        if (expiresAt <= now) {
          entries.delete(seen);
        }
      }
      return entries.has(key);
    },
    record(key: string, ttlMs: number): void {
      entries.delete(key);
      entries.set(key, Date.now() + ttlMs);
      for (const [seen] of entries) {
        if (entries.size <= maxEntries) {
          break;
        }
        entries.delete(seen);
      }
    },
  };
}

export type SignedReplayScope = {
  mappingId: string;
  deliveryId: string;
  /** Exact bytes the signature covers; re-verified whenever authority is re-checked. */
  rawBody: string;
  /** Replaces the bearer token in replay keys: signed admission never validated one. */
  authority: string;
  /** Replay path scope tied to the mapping, so URL aliases share one identity. */
  pathKey: string;
  /** Ledger key for wake dedupe: mapping id plus verified delivery id. */
  wakeKey: string;
  /** How long replay records for this delivery must live: until the signed timestamp can no longer verify. */
  retentionMs: number;
};

/** Replay identity for an admitted signed delivery, or undefined for token-admitted requests. */
export function describeSignedAdmission(
  admission: HookRequestAdmission,
  minTtlMs: number,
): SignedReplayScope | undefined {
  if (!admission.ok || !admission.signedMappingId || !admission.signedDeliveryId) {
    return undefined;
  }
  const identity = `${admission.signedMappingId}:${admission.signedPath ?? ""}`;
  return {
    mappingId: admission.signedMappingId,
    deliveryId: admission.signedDeliveryId,
    rawBody: admission.body.raw ?? "",
    authority: `signature:${identity}`,
    pathKey: `signed:${identity}`,
    wakeKey: `${identity}:${admission.signedDeliveryId}`,
    // A future-dated timestamp verifies until timestamp + tolerance, which can exceed
    // one tolerance window from receipt; keep records until it cannot verify anymore.
    retentionMs: Math.max(
      minTtlMs,
      (admission.signedExpiresAtMs ?? 0) - Date.now(),
      (admission.signedToleranceSeconds ?? 0) * 1000,
    ),
  };
}

/**
 * Replay scope for a signed dispatch: only signed facts (mapping, delivery, and
 * the item's position in the signed payload). Rendered action values can embed
 * unsigned inputs such as request headers, which must not mint a new identity.
 */
export function signedDispatchScope(
  signed: SignedReplayScope,
  item: number,
): Record<string, unknown> {
  return { mappingId: signed.mappingId, deliveryId: signed.deliveryId, item };
}

/**
 * Re-check signing authority against the live configuration after asynchronous
 * work (transforms) ran between admission and dispatch. Answers 401 and returns
 * false when the mapping or its secret no longer verifies the signed bytes.
 */
export function ensureSignedAuthorityCurrent(params: {
  mappingId: string;
  rawBody: string;
  resolveHooksConfig: () => HooksConfigResolved | null | undefined;
  subPath: string;
  headers: Record<string, string>;
  res: ServerResponse;
  clientKey: string;
  limiter: HookAuthLimiter;
  warn: (message: string) => void;
}): boolean {
  const current = params.resolveHooksConfig() ?? undefined;
  const owner = current ? resolveHookPathSignature(current.mappings, params.subPath) : undefined;
  const verified =
    owner?.signature !== undefined &&
    owner.mappingId === params.mappingId &&
    verifyStandardWebhooksSignature({
      headers: params.headers,
      rawBody: params.rawBody,
      secrets: owner.signature.secrets,
      toleranceSeconds: owner.signature.toleranceSeconds,
    }).ok;
  if (verified) {
    return true;
  }
  params.warn(`hook ${params.subPath} rejected: signing authority changed before dispatch`);
  sendHookUnauthorized({
    res: params.res,
    clientKey: params.clientKey,
    limiter: params.limiter,
    warn: params.warn,
  });
  return false;
}
