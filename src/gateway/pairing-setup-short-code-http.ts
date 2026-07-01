// Redeems setup short codes into the canonical mobile setup-code payload.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizePairingSetupShortCodeInput,
  redeemPairingSetupShortCode,
} from "../pairing/setup-short-code.js";
import {
  AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendRateLimited,
} from "./http-common.js";
import { resolveRequestClientIp } from "./net.js";

const PAIRING_SETUP_SHORT_CODE_REDEEM_MAX_BODY_BYTES = 1024;

function resolveRequestCode(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return normalizePairingSetupShortCodeInput(body.code);
}

export async function handlePairingSetupShortCodeRedeemHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    trustedProxies: string[];
    allowRealIpFallback: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const clientIp = resolveRequestClientIp(req, opts.trustedProxies, opts.allowRealIpFallback);
  const limit = opts.rateLimiter?.check(clientIp, AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE);
  if (limit && !limit.allowed) {
    sendRateLimited(res, limit.retryAfterMs);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, PAIRING_SETUP_SHORT_CODE_REDEEM_MAX_BODY_BYTES);
  if (body === undefined) {
    opts.rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE);
    return true;
  }

  const code = resolveRequestCode(body);
  if (!code) {
    opts.rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE);
    sendInvalidRequest(res, "Invalid or expired setup code.");
    return true;
  }

  const redeemed = redeemPairingSetupShortCode(code);
  if (!redeemed.ok) {
    opts.rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE);
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "invalid_or_expired_setup_code",
        message: "Invalid or expired setup code.",
      },
    });
    return true;
  }

  opts.rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_PAIRING_SETUP_SHORT_CODE);
  sendJson(res, 200, {
    ok: true,
    payload: redeemed.payload,
    expiresAtMs: redeemed.expiresAtMs,
  });
  return true;
}
