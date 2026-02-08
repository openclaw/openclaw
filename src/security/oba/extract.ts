import type { ObaBlock, ObaVerificationResult } from "./types.js";
import { validateOwnerUrl } from "./owner-url.js";

/**
 * Extract and validate an OBA block from a raw value.
 * Returns `{ oba }` if valid, `{ error }` if malformed, or `{ oba: undefined }` if absent.
 */
export function extractObaBlock(value: unknown): { oba?: ObaBlock; error?: string } {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "malformed oba block: expected object" };
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.owner !== "string" || obj.owner.length === 0) {
    return { error: "malformed oba block: owner must be a non-empty string" };
  }

  // Validate owner URL (HTTPS, no credentials/fragments, no private hosts).
  const urlResult = validateOwnerUrl(obj.owner);
  if (!urlResult.ok) {
    return { error: `malformed oba block: ${urlResult.error}` };
  }

  if (typeof obj.kid !== "string" || obj.kid.length === 0) {
    return { error: "malformed oba block: kid must be a non-empty string" };
  }

  if (obj.alg !== "EdDSA") {
    return { error: 'malformed oba block: alg must be "EdDSA"' };
  }

  if (typeof obj.sig !== "string" || obj.sig.length === 0) {
    return { error: "malformed oba block: sig must be a non-empty string" };
  }

  return {
    oba: {
      owner: obj.owner,
      kid: obj.kid,
      alg: obj.alg,
      sig: obj.sig,
    },
  };
}

/**
 * Classify an OBA value offline (no network). Returns status + parsed block if valid.
 * - absent => unsigned
 * - well-formed => signed
 * - malformed => invalid (with reason)
 */
export function classifyObaOffline(obaValue: unknown): {
  oba?: ObaBlock;
  verification: ObaVerificationResult;
} {
  if (obaValue === undefined || obaValue === null) {
    return { verification: { status: "unsigned" } };
  }

  const result = extractObaBlock(obaValue);

  if (result.error) {
    return {
      verification: { status: "invalid", reason: result.error },
    };
  }

  if (result.oba) {
    return {
      oba: result.oba,
      verification: { status: "signed", ownerUrl: result.oba.owner },
    };
  }

  return { verification: { status: "unsigned" } };
}
