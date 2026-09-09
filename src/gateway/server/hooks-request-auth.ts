// Hook request admission: shared-token auth, or a sender signature on paths that declare one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH, type createAuthRateLimiter } from "../auth-rate-limit.js";
import { resolveHookPathSignature, verifyStandardWebhooksSignature } from "../hooks-signature.js";
import { type HooksConfigResolved, readHookRequestBody, readJsonBody } from "../hooks.js";
import { sendJson } from "../http-common.js";

type HookAuthLimiter = ReturnType<typeof createAuthRateLimiter>;

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
      /** Configuration current at verification time; the handler continues with it. */
      hooksConfig?: HooksConfigResolved;
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
  return {
    ok: true,
    body: body.value,
    signedDeliveryId: verification.deliveryId,
    signedMappingId: currentOwner.mappingId,
    signedToleranceSeconds: currentSignature.toleranceSeconds,
    hooksConfig: current,
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
  /** Replaces the bearer token in replay keys: signed admission never validated one. */
  authority: string;
  /** Replay path scope tied to the mapping, so URL aliases share one identity. */
  pathKey: string;
  /** Ledger key for wake dedupe: mapping id plus verified delivery id. */
  wakeKey: string;
  /** Wake dedupe TTL: at least the cache floor, never shorter than the replay window. */
  wakeTtlMs: number;
};

/** Replay identity for an admitted signed delivery, or undefined for token-admitted requests. */
export function describeSignedAdmission(
  admission: HookRequestAdmission,
  minTtlMs: number,
): SignedReplayScope | undefined {
  if (!admission.ok || !admission.signedMappingId || !admission.signedDeliveryId) {
    return undefined;
  }
  return {
    authority: `signature:${admission.signedMappingId}`,
    pathKey: `signed:${admission.signedMappingId}`,
    wakeKey: `${admission.signedMappingId}:${admission.signedDeliveryId}`,
    wakeTtlMs: Math.max(minTtlMs, (admission.signedToleranceSeconds ?? 0) * 1000),
  };
}
