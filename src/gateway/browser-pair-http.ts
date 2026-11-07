// Public device-code pairing for browsers that hold no Gateway credential yet.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
  verifyDeviceSignature,
} from "../infra/device-identity.js";
import {
  cancelBrowserPairRequest,
  collectBrowserPairRequest,
  startBrowserPairRequest,
} from "../infra/device-pairing-browser-code.js";
import {
  BROWSER_PAIR_IDENTITY_REQUIRED_MESSAGE,
  buildBrowserPairPayload,
  type BrowserPairAction,
} from "../shared/browser-pair.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  AUTH_RATE_LIMIT_SCOPE_BROWSER_PAIR,
  AUTH_RATE_LIMIT_SCOPE_BROWSER_PAIR_COLLECT,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import { getHeader } from "./http-header-value.js";
import { resolveAcceptedBrowserOrigin } from "./origin-check.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";

const BROWSER_PAIR_MAX_BODY_BYTES = 4 * 1024;
const BROWSER_PAIR_MAX_METADATA_CHARS = 256;
const BROWSER_PAIR_COLLECT_MIN_INTERVAL_MS = 1_000;
const BROWSER_PAIR_COLLECT_THROTTLE_MAX_ENTRIES = 1_024;

// A valid waiting browser never spends the failure budget, so its polls are paced
// here instead: repeats inside the interval answer without queueing on the pairing lock.
const lastCollectAtMs = new Map<string, number>();

type BrowserPairBody = {
  deviceId: string;
  publicKey: string;
  signature: string;
  requestId?: string;
};

function parseBody(value: unknown): BrowserPairBody | null {
  if (!isRecord(value)) {
    return null;
  }
  const { deviceId, publicKey, signature, requestId } = value;
  if (
    typeof deviceId !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    (requestId !== undefined && typeof requestId !== "string")
  ) {
    return null;
  }
  return { deviceId, publicKey, signature, requestId };
}

/** Prove the caller holds the device key it names; returns the canonical public key. */
function verifyBrowserPairProof(action: BrowserPairAction, body: BrowserPairBody): string | null {
  const publicKey = normalizeDevicePublicKeyBase64Url(body.publicKey);
  if (!publicKey || deriveDeviceIdFromPublicKey(publicKey) !== body.deviceId) {
    return null;
  }
  const payload = buildBrowserPairPayload({
    action,
    deviceId: body.deviceId,
    requestId: body.requestId,
  });
  return verifyDeviceSignature(publicKey, payload, body.signature) ? publicKey : null;
}

function boundedMetadata(value: string | undefined): string | undefined {
  return value?.trim().slice(0, BROWSER_PAIR_MAX_METADATA_CHARS) || undefined;
}

/** Handle the core-owned browser pairing namespace before hooks, plugins, and the SPA. */
export async function handleBrowserPairHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  action: BrowserPairAction;
  config: OpenClawConfig;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  const { req, res, action, clientIp, rateLimiter } = params;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  // Keeps other sites from filing requests from a browser that can reach this Gateway.
  // A CSRF gate, not a network boundary: host approval and the key proof own authority.
  const origin = resolveAcceptedBrowserOrigin({ req, cfg: params.config });
  if (!origin) {
    sendJson(res, 403, { error: "origin_not_allowed" });
    return true;
  }
  const rawBody = await readJsonBodyOrError(req, res, BROWSER_PAIR_MAX_BODY_BYTES);
  if (rawBody === undefined) {
    return true;
  }

  const scope =
    action === "start"
      ? AUTH_RATE_LIMIT_SCOPE_BROWSER_PAIR
      : AUTH_RATE_LIMIT_SCOPE_BROWSER_PAIR_COLLECT;
  await withSerializedRateLimitAttempt({
    ip: clientIp,
    scope,
    run: async () => {
      const rateCheck = rateLimiter?.check(clientIp, scope);
      if (rateCheck && !rateCheck.allowed) {
        if (rateCheck.retryAfterMs > 0) {
          res.setHeader("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
        }
        sendJson(res, 429, { error: "rate_limited" });
        return;
      }
      const body = parseBody(rawBody);
      const publicKey = body ? verifyBrowserPairProof(action, body) : null;
      if (!body || !publicKey) {
        rateLimiter?.recordFailure(clientIp, scope);
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }
      const context = captureOpenClawStateWorkerContext();
      if (action === "start") {
        if (params.config.gateway?.roles) {
          sendJson(res, 409, {
            error: "identity_required",
            message: BROWSER_PAIR_IDENTITY_REQUIRED_MESSAGE,
          });
          return;
        }
        // Every filed request spends budget: rows are bounded per Gateway, not per source.
        rateLimiter?.recordFailure(clientIp, scope);
        const started = await startBrowserPairRequest({
          context,
          deviceId: body.deviceId,
          publicKey,
          remoteIp: clientIp,
          userAgent: boundedMetadata(getHeader(req, "user-agent")),
          origin: boundedMetadata(origin),
        });
        if (started.status === "capacity") {
          sendJson(res, 429, { error: "capacity" });
          return;
        }
        const { requestId, code, expiresAtMs } = started;
        sendJson(res, 200, { requestId, code, expiresAtMs });
        return;
      }

      const requestId = body.requestId ?? "";
      const now = Date.now();
      // Keyed by caller too: only the proven holder of this request may read its answer.
      const throttleKey = `${body.deviceId}:${requestId}`;
      if (action === "cancel") {
        // Missing requests are idempotent, so every cancellation spends public-route budget.
        rateLimiter?.recordFailure(clientIp, scope);
        const cancelled = await cancelBrowserPairRequest({
          context,
          requestId,
          deviceId: body.deviceId,
          publicKey,
        });
        lastCollectAtMs.delete(throttleKey);
        sendJson(res, 200, cancelled);
        return;
      }
      const lastAtMs = lastCollectAtMs.get(throttleKey);
      if (lastAtMs !== undefined && now - lastAtMs < BROWSER_PAIR_COLLECT_MIN_INTERVAL_MS) {
        sendJson(res, 200, { status: "pending" });
        return;
      }
      const collected = await collectBrowserPairRequest({
        context,
        requestId,
        deviceId: body.deviceId,
        publicKey,
      });
      if (collected.status === "unknown") {
        rateLimiter?.recordFailure(clientIp, scope);
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      if (collected.status === "pending") {
        if (lastCollectAtMs.size >= BROWSER_PAIR_COLLECT_THROTTLE_MAX_ENTRIES) {
          lastCollectAtMs.clear();
        }
        lastCollectAtMs.set(throttleKey, now);
      } else {
        lastCollectAtMs.delete(throttleKey);
      }
      sendJson(res, 200, collected);
    },
  });
  return true;
}
