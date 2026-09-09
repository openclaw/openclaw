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

/** Built-in hook endpoints always keep the shared-token contract; a mapping signature never admits them. */
export const HOOK_BUILT_IN_PATHS: ReadonlySet<string> = new Set(["agent", "wake"]);

export type HookPathSignatureOwner = {
  mappingId: string;
  signature: HookMappingSignatureResolved;
};

function normalizeHookPath(hookPath: string): string {
  return hookPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Signature policy for a custom request path, decided before the body is
 * trusted. A signed mapping must be the only mapping able to match its path
 * (enforced by `assertHookSignatureMappingsExclusive`), so the mapping that
 * authenticates the request is the mapping that dispatches it. Built-in
 * `agent` and `wake` never authenticate by signature.
 */
export function resolveHookPathSignature(
  mappings: readonly HookMappingResolved[],
  hookPath: string,
): HookPathSignatureOwner | undefined {
  const normalizedPath = normalizeHookPath(hookPath);
  if (!normalizedPath || HOOK_BUILT_IN_PATHS.has(normalizedPath)) {
    return undefined;
  }
  for (const mapping of mappings) {
    if (mapping.matchPath && mapping.matchPath !== normalizedPath) {
      continue;
    }
    return mapping.signature ? { mappingId: mapping.id, signature: mapping.signature } : undefined;
  }
  return undefined;
}

/**
 * A signed mapping owns its path exclusively: it needs an explicit custom
 * `match.path` (never a built-in endpoint), and no other mapping may match
 * that path, whether by the same `match.path` or by omitting `match.path`.
 * Otherwise a request could authenticate with one mapping's secret and
 * dispatch another mapping's action via `match.source`. Returns the first
 * violation as a message, or undefined.
 */
export function findHookSignatureMappingConflict(
  mappings: readonly { id: string; matchPath?: string; signature?: unknown }[],
): string | undefined {
  for (const mapping of mappings) {
    if (!mapping.signature) {
      continue;
    }
    if (!mapping.matchPath) {
      return `Hook mapping "${mapping.id}" declares a signature but no match.path; signed mappings must own an explicit custom path`;
    }
    if (HOOK_BUILT_IN_PATHS.has(mapping.matchPath)) {
      return `Hook mapping "${mapping.id}" cannot sign the built-in hook path "${mapping.matchPath}"`;
    }
    const overlap = mappings.find(
      (other) => other !== mapping && (!other.matchPath || other.matchPath === mapping.matchPath),
    );
    if (overlap) {
      return `Hook mapping "${mapping.id}" declares a signature for path "${mapping.matchPath}" but mapping "${overlap.id}" can also match that path; a signed path must belong to one mapping`;
    }
  }
  return undefined;
}
