import { createHash, randomBytes } from "node:crypto";

/**
 * Encode a flat object as application/x-www-form-urlencoded form data.
 *
 * Inputs are intentionally string-only so provider code chooses how to serialize arrays, booleans,
 * and optional values before the token exchange leaves the SDK boundary.
 *
 * @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
 */
export function toFormUrlEncoded(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * Generate a PKCE verifier/challenge pair suitable for OAuth authorization flows.
 *
 * Uses a base64url verifier, matching the historical helper contract that several provider plugins
 * still import through the provider-auth barrel.
 *
 * @deprecated OAuth provider-owned helper; keep this local to provider plugins instead.
 */
export function generatePkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Generate a PKCE verifier/challenge pair with a 64-character hex verifier.
 *
 * Some providers reject base64url verifiers despite accepting S256 challenges, so this helper keeps
 * the verifier alphabet to lowercase hex while deriving the challenge from those exact bytes.
 */
export function generateHexPkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
