// Sender-signature verification for mapped hook paths (hooks.mappings[].signature).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { HookMappingSignature } from "../config/types.hooks.js";
import type { HookMappingResolved } from "./hooks-mapping.js";

export type HookMappingSignatureResolved = {
  scheme: "standard-webhooks";
  secrets: Buffer[];
  toleranceSeconds: number;
};

export const HOOK_SIGNATURE_DEFAULT_TOLERANCE_SECONDS = 300;
const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";
const STANDARD_WEBHOOKS_MIN_SECRET_BYTES = 16;

export type HookSignatureFailureReason =
  | "missing-headers"
  | "invalid-timestamp"
  | "timestamp-out-of-tolerance"
  | "unsupported-signature-version"
  | "signature-mismatch";

export type HookSignatureVerification =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: HookSignatureFailureReason };

/** Decode a `whsec_<base64>` (or bare base64) Standard Webhooks secret; null when malformed. */
export function decodeStandardWebhooksSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  const encoded = trimmed.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? trimmed.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : trimmed;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return null;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length >= STANDARD_WEBHOOKS_MIN_SECRET_BYTES ? key : null;
}

/**
 * Verify a Standard Webhooks signature (https://www.standardwebhooks.com/, the
 * scheme Svix and Svix-compatible senders use): `webhook-signature` carries one
 * or more `v1,<base64 HMAC-SHA256>` entries computed over
 * `<webhook-id>.<webhook-timestamp>.<raw body>`. Any configured secret may
 * match, so a sender rotating its secret keeps verifying during the overlap.
 */
export function verifyStandardWebhooksSignature(params: {
  headers: Record<string, string>;
  rawBody: string;
  secrets: readonly Buffer[];
  toleranceSeconds?: number;
  nowMs?: number;
}): HookSignatureVerification {
  const id = params.headers["webhook-id"]?.trim() ?? "";
  const timestamp = params.headers["webhook-timestamp"]?.trim() ?? "";
  const signatureHeader = params.headers["webhook-signature"]?.trim() ?? "";
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing-headers" };
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  const tolerance = params.toleranceSeconds ?? HOOK_SIGNATURE_DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "timestamp-out-of-tolerance" };
  }
  const provided = signatureHeader
    .split(/\s+/)
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
  if (provided.length === 0) {
    return { ok: false, reason: "unsupported-signature-version" };
  }
  const signedContent = `${id}.${timestamp}.${params.rawBody}`;
  for (const secret of params.secrets) {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(signedContent, "utf8").digest("base64"),
    );
    for (const candidate of provided) {
      const actual = Buffer.from(candidate);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return { ok: true, deliveryId: id };
      }
    }
  }
  return { ok: false, reason: "signature-mismatch" };
}

/** Resolve a mapping's `signature` block once at config load; malformed secrets fail loudly. */
export function normalizeHookMappingSignature(
  signature: HookMappingSignature,
  mappingId: string,
): HookMappingSignatureResolved {
  const rawSecrets = Array.isArray(signature.secret) ? signature.secret : [signature.secret];
  const secrets: Buffer[] = [];
  for (const raw of rawSecrets) {
    const decoded = decodeStandardWebhooksSecret(raw);
    if (!decoded) {
      throw new Error(
        `Hook mapping "${mappingId}" signature secret must be a whsec_-prefixed base64 value of at least 16 bytes`,
      );
    }
    secrets.push(decoded);
  }
  return {
    scheme: signature.scheme,
    secrets,
    toleranceSeconds: signature.toleranceSeconds ?? HOOK_SIGNATURE_DEFAULT_TOLERANCE_SECONDS,
  };
}

/**
 * Signature policy for a request path, decided before the body is trusted: the
 * first mapping whose `match.path` covers the path owns authentication for it,
 * mirroring the first-match dispatch order. Source matching needs the payload
 * and therefore cannot influence authentication.
 */
export function resolveHookPathSignature(
  mappings: readonly HookMappingResolved[],
  hookPath: string,
): HookMappingSignatureResolved | undefined {
  const normalizedPath = hookPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  for (const mapping of mappings) {
    if (mapping.matchPath && mapping.matchPath !== normalizedPath) {
      continue;
    }
    return mapping.signature;
  }
  return undefined;
}
