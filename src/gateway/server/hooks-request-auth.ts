// Hook request admission: shared-token auth, or a sender signature on paths that declare one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH, type createAuthRateLimiter } from "../auth-rate-limit.js";
import { resolveHookPathSignature, verifyStandardWebhooksSignature } from "../hooks-signature.js";
import { type HookRequestBody, type HooksConfigResolved, readHookRequestBody } from "../hooks.js";
import { sendJson } from "../http-common.js";

type HookAuthLimiter = ReturnType<typeof createAuthRateLimiter>;

export type HookRequestAdmission =
  | {
      ok: true;
      /** Body already read when a signature had to be verified over the raw bytes. */
      body?: HookRequestBody;
      /** Verified sender delivery id (`webhook-id`); the replay identity for signed deliveries. */
      signedDeliveryId?: string;
      /** Mapping whose secret authenticated the request; scopes its replay cache. */
      signedMappingId?: string;
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
    return { ok: true };
  }
  const body = await readHookRequestBody(req, params.bodyLimit);
  if (!body.ok) {
    await sendHookBodyError(req, res, body.error);
    return { ok: false };
  }
  const verification = verifyStandardWebhooksSignature({
    headers: params.headers,
    rawBody: body.value.raw,
    secrets: pathSignature.secrets,
    toleranceSeconds: pathSignature.toleranceSeconds,
  });
  if (!verification.ok) {
    params.warn(
      `hook ${subPath} rejected: ${pathSignature.scheme} signature ${verification.reason}`,
    );
    reject();
    return { ok: false };
  }
  limiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
  return {
    ok: true,
    body: body.value,
    signedDeliveryId: verification.deliveryId,
    signedMappingId: owner.mappingId,
  };
}
